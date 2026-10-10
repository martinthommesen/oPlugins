import type { Credential } from "@opencode/plugin"
import type { Context, Plugin } from "@opencode/plugin/promise/plugin"
import type {
  SessionHttpRequest,
  SessionHttpResponse,
  SessionRequestKind,
} from "@opencode/plugin/promise/session"
import { setTimeout as sleep } from "node:timers/promises"
import {
  adoptExternalCredential,
  authorizeAccount,
  ClaudeAuthRefreshExhaustedError,
  ClaudeAuthTerminalError,
  buildAccountForm,
  credentialLabel,
  type CredentialDependencies,
  type CredentialRefreshResult,
  INTEGRATION_ID,
  isClaudeCodeCredential,
  METHOD_ID,
  readMetadata,
  refreshClaudeCredentialDetailed,
} from "./credentials.ts"
import {
  readAllClaudeAccounts,
  readSourceCredentials,
  type ClaudeAccount,
} from "./keychain.ts"
import { closeLogger, errorMessage, initLogger, log, warn } from "./logger.ts"
import {
  authenticationErrorResponse,
  buildRequestFromSnapshot,
  restoreResponseToolNames,
  retryableRefreshResponse,
  transformContext,
  transformRequest,
  type OriginalByAlias,
  type RequestSnapshot,
} from "./transforms.ts"

const SOURCE_CACHE_TTL_MS = 30_000
const EVENT_RESUBSCRIBE_DELAY_MS = 1_000
const DISPOSE_STEP_TIMEOUT_MS = 5_000
/**
 * Session and request-kind pairs whose wire aliases are retained. Only a
 * fallback for when the per-request state is unavailable, so evicting the
 * coldest entry costs at most one response's tool-name restoration in a
 * session that went quiet.
 */
const MAX_TRACKED_CONTEXTS = 512

/**
 * The host build this release targets. The compatibility error, the smoke
 * test's CLI install, and its version check all read it, so bumping the host is one edit here plus `package.json`.
 */
export const REQUIRED_HOST_VERSION = "2.0.26"

interface RequestState {
  credential: Credential.OAuth
  snapshot: RequestSnapshot
}

function assertCapabilities(ctx: Context): void {
  const capabilities: Array<[string, unknown]> = [
    ["integration.transform", ctx.integration?.transform],
    ["integration.connection.active", ctx.integration?.connection?.active],
    ["integration.connection.resolve", ctx.integration?.connection?.resolve],
    ["model.transform", ctx.model?.transform],
    ["model.reload", ctx.model?.reload],
    ["event.subscribe", ctx.event?.subscribe],
    ["session.hook", ctx.session?.hook],
  ]
  const missing = capabilities
    .filter(([, value]) => typeof value !== "function")
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(
      `opencode-claude-auth requires a compatible OpenCode v2 Promise plugin API (target: v${REQUIRED_HOST_VERSION}; missing: ${missing.join(", ")})`,
    )
  }
}

function sameCredential(
  left: Credential.OAuth | null,
  right: Credential.OAuth,
): boolean {
  if (!left) return false
  const leftMetadata = readMetadata(left)
  const rightMetadata = readMetadata(right)
  return (
    left.access === right.access &&
    leftMetadata?.source === rightMetadata?.source &&
    leftMetadata?.configDir === rightMetadata?.configDir
  )
}

// The host types `kind` as required, but an event can arrive without it.
function aliasKey(
  sessionID: string,
  kind: SessionRequestKind = "primary",
): string {
  return `${sessionID}:${kind}`
}

export interface PluginDependencies {
  readAccounts: () => Promise<ClaudeAccount[]>
  readSource: CredentialDependencies["readSource"]
  adopt: (credential: Credential.OAuth) => Promise<CredentialRefreshResult>
  refresh: (credential: Credential.OAuth) => Promise<CredentialRefreshResult>
  fetch: typeof fetch
  now: () => number
  /** Wait before re-subscribing after the host event stream fails or ends. */
  eventResubscribeDelayMs: number
}

/**
 * Run a teardown step, logging instead of aborting the steps after it. The
 * timeout matters as much as the catch. A step that never settles would
 * otherwise block every later step, including closing the log.
 */
async function settle(
  step: string,
  run: () => Promise<unknown>,
): Promise<void> {
  const timer = new AbortController()
  try {
    await Promise.race([
      run(),
      sleep(DISPOSE_STEP_TIMEOUT_MS, undefined, { signal: timer.signal }).then(
        () => {
          throw new Error(`${step} did not settle`)
        },
      ),
    ])
  } catch (error) {
    log("dispose_failed", { step, error: errorMessage(error) })
  } finally {
    // Clear the timer, because the race does not cancel the loser.
    timer.abort()
  }
}

/** Release a response this plugin is dropping, so undici can reclaim it now. */
function discard(response: Response): void {
  if (response.bodyUsed || !response.body) return
  void response.body.cancel().catch(() => {
    // The body is already errored or locked, so there is nothing to release.
  })
}

/** @internal Exported to test the host-facing plugin contract. */
export async function setupClaudeAuth(
  ctx: Context,
  overrides: Partial<PluginDependencies> = {},
) {
  const deps: PluginDependencies = {
    readAccounts: readAllClaudeAccounts,
    readSource: readSourceCredentials,
    adopt: adoptExternalCredential,
    refresh: refreshClaudeCredentialDetailed,
    fetch: globalThis.fetch,
    now: Date.now,
    eventResubscribeDelayMs: EVENT_RESUBSCRIBE_DELAY_MS,
    ...overrides,
  }
  assertCapabilities(ctx)
  try {
    initLogger()
  } catch (error) {
    // A rejected CLAUDE_AUTH_DEBUG value must not take the plugin down with
    // it, and there is no log to report it to yet.
    process.stderr.write(`opencode-claude-auth: ${errorMessage(error)}\n`)
  }

  // A discovery failure (a locked Keychain, say) is kept so /connect can show
  // its cause instead of reporting that no credentials exist. Discovery can
  // take seconds, so the session hooks register while it runs. It never
  // rejects, so leaving it unawaited until then cannot go unhandled.
  let startupAccounts: ClaudeAccount[] = []
  let startupError: unknown
  const discovery = deps.readAccounts().then(
    (accounts) => {
      startupAccounts = accounts
    },
    (error: unknown) => {
      startupError = error
      log("account_discovery_failed", { error: errorMessage(error) })
    },
  )

  let activeCredential: Credential.OAuth | null = null
  let sourceCheckedAt = 0
  const requestStates = new WeakMap<Request, RequestState>()
  // The wire aliases in use, per session and request kind (see `aliasKey`).
  // The context hook resets an entry each turn with the registered tools, and
  // the request hook adds what the body it rewrote carried. The body's
  // entries go last, so when two tools compete for one alias, the mapping the
  // request was sent with wins. Keyed by session rather than by Request,
  // because the host may hand the response hook a different Request, and a
  // hook that re-runs on its own output finds nothing new to alias. Bounded,
  // because the plugin lives in a server that outlives any individual session
  // and the host has no session-ended signal to unsubscribe from.
  const sessionAliases = new Map<string, OriginalByAlias>()
  const rememberAliases = (key: string, aliases: OriginalByAlias): void => {
    // Re-inserting moves the entry to the end, so eviction takes the session
    // that has been idle longest rather than the one that started first.
    sessionAliases.delete(key)
    sessionAliases.set(key, aliases)
    if (sessionAliases.size > MAX_TRACKED_CONTEXTS) {
      const [oldest] = sessionAliases.keys()
      sessionAliases.delete(oldest)
    }
  }
  const registrations: Array<{ dispose(): Promise<void> }> = []

  /** Adopt `next` in place of `previous`, unless a switch replaced it. */
  const updateActive = (
    previous: Credential.OAuth,
    next: Credential.OAuth,
  ): void => {
    if (sameCredential(activeCredential, previous)) activeCredential = next
  }

  /**
   * Re-read the source for a rotation made outside OpenCode, and resolve to
   * the credential to use from now on.
   */
  let pendingRecheck: Promise<Credential.OAuth> | undefined
  const recheckSource = (
    credential: Credential.OAuth,
  ): Promise<Credential.OAuth> => {
    sourceCheckedAt = deps.now()
    pendingRecheck = deps.adopt(credential).then(
      (adopted) => {
        if (adopted.kind !== "adopted") return credential
        updateActive(credential, adopted.credential)
        return adopted.credential
      },
      (error) => {
        log("source_recheck_failed", { error: errorMessage(error) })
        return credential
      },
    )
    return pendingRecheck
  }

  // These hooks do nothing until a credential loads, so they need neither
  // the account list nor each other, and register at once.
  const sessionHooks: Array<Promise<{ dispose(): Promise<void> }>> = []

  // Auxiliary model calls need the same subscription identity as the agent
  // loop. Their aliases are kept apart because a title can run concurrently.
  for (const hook of ["context", "compaction", "generate", "title"] as const) {
    sessionHooks.push(
      ctx.session.hook(
        hook,
        (event) => {
          const key = aliasKey(
            event.sessionID,
            hook === "context" ? "primary" : hook,
          )
          if (activeCredential) {
            rememberAliases(key, transformContext(event))
          } else {
            sessionAliases.delete(key)
          }
        },
        { providerID: INTEGRATION_ID },
      ),
    )
  }

  sessionHooks.push(
    ctx.session.hook(
      "http.request",
      async (event: SessionHttpRequest) => {
        let credential = activeCredential
        if (!credential) return

        const now = deps.now()
        if (now - sourceCheckedAt >= SOURCE_CACHE_TTL_MS) {
          // A source read can take seconds on a slow Keychain, so it runs
          // beside the request. The token it may replace stays valid until it
          // expires, and a 401 recovers through adoption anyway. Only an
          // expired token, a certain 401, is worth waiting for.
          const rechecked = recheckSource(credential)
          if (credential.expires <= now) credential = await rechecked
        }

        const transformed = await transformRequest(event, credential)
        const key = aliasKey(event.sessionID, event.kind)
        rememberAliases(key, {
          ...sessionAliases.get(key),
          ...transformed.originalByAlias,
        })
        event.request = transformed.request
        requestStates.set(transformed.request, {
          credential,
          snapshot: transformed.snapshot,
        })
      },
      { providerID: INTEGRATION_ID },
    ),
  )

  const attemptRecovery = async (
    original: Response,
    state: RequestState,
    opened: Response[],
  ): Promise<Response> => {
    let credential = state.credential
    let response = original

    // Every response this opens is recorded, so the caller can release the
    // ones it does not return without each step having to know which of its
    // predecessors is still live.
    const replay = async (next: Credential.OAuth): Promise<Response> => {
      const replayed = await deps.fetch(
        buildRequestFromSnapshot(state.snapshot, next),
      )
      opened.push(replayed)
      return replayed
    }

    // A refresh adopts a credential rotated outside OpenCode before it spends
    // a refresh token. When the adopted one is rejected as well, the second
    // call has nothing left to adopt and refreshes.
    let refreshed = await deps.refresh(credential)
    if (refreshed.kind === "adopted") {
      updateActive(credential, refreshed.credential)
      credential = refreshed.credential
      response = await replay(credential)
      if (response.status !== 401) return response
      refreshed = await deps.refresh(credential)
    }

    if (refreshed.kind === "transient") {
      return retryableRefreshResponse(refreshed.retryAfterMs)
    }
    updateActive(credential, refreshed.credential)
    if (refreshed.credential.access !== credential.access) {
      response = await replay(refreshed.credential)
    } else {
      log("unauthorized_recovery_unchanged", { kind: refreshed.kind })
    }
    return response
  }

  /**
   * Recovery is best-effort, and nothing escapes the hook. A credential error
   * the user has to act on becomes a 401 carrying its message; an aborted
   * turn or any other failure surfaces as the original 401, which the SDK
   * already knows how to report.
   */
  const recoverUnauthorized = async (
    original: Response,
    state: RequestState,
  ): Promise<Response> => {
    if (state.snapshot.signal.aborted) return original
    const opened: Response[] = []
    let resolved = original
    try {
      resolved = await attemptRecovery(original, state, opened)
    } catch (error) {
      log("unauthorized_recovery_failed", { error: errorMessage(error) })
      if (
        error instanceof ClaudeAuthTerminalError ||
        error instanceof ClaudeAuthRefreshExhaustedError
      ) {
        resolved = authenticationErrorResponse(error.message)
      }
    }
    for (const response of [original, ...opened]) {
      if (response !== resolved) discard(response)
    }
    return resolved
  }

  sessionHooks.push(
    ctx.session.hook(
      "http.response",
      async (event: SessionHttpResponse) => {
        const state = requestStates.get(event.request)
        const originalByAlias = sessionAliases.get(
          aliasKey(event.sessionID, event.kind),
        )
        // Neither hook saw this session with a credential.
        if (!state && !originalByAlias) return
        if (!state) {
          // The host handed back a Request other than the one the request
          // hook produced, so 401 recovery is skipped for this turn. Tool
          // names still restore from the session's aliases, which makes the
          // degradation invisible without this.
          log("request_state_missing", { sessionID: event.sessionID })
        }

        // The plugin's own retryable 429 has no aliases to restore, so the
        // rewrite below passes it through without a match.
        const resolved =
          state && event.response.status === 401
            ? await recoverUnauthorized(event.response, state)
            : event.response
        event.response = restoreResponseToolNames(
          resolved,
          originalByAlias ?? {},
        )
      },
      { providerID: INTEGRATION_ID },
    ),
  )

  registrations.push(...(await Promise.all(sessionHooks)))
  await discovery

  const form = buildAccountForm(startupAccounts)
  registrations.push(
    await ctx.integration.transform((draft) => {
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_ID,
          type: "oauth",
          label: "Import Claude Code subscription",
          ...(form ? { form } : {}),
        },
        authorize: async (answer) => {
          if (startupAccounts.length === 0 && startupError !== undefined) {
            throw startupError
          }
          const credential = await authorizeAccount(startupAccounts, answer, {
            readSource: deps.readSource,
          })
          return {
            mode: "auto",
            url: "",
            instructions: "Claude Code credentials imported from this device.",
            callback: Promise.resolve(credential),
          }
        },
        refresh: async (credential) => {
          const result = await deps.refresh(credential)
          updateActive(credential, result.credential)
          return result.credential
        },
        label: credentialLabel,
      })
    }),
  )

  /**
   * Swap in the active connection's credential once it is known, so a
   * request racing the reload keeps the credential it would have used a
   * moment earlier instead of going out with none. A failed reload still
   * ends with none, because the user switched away from the old one.
   */
  const loadActiveCredential = async (): Promise<void> => {
    let next: Credential.OAuth | null = null
    try {
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      const credential = connection
        ? await ctx.integration.connection.resolve(connection)
        : undefined
      next = isClaudeCodeCredential(credential) ? credential : null
    } finally {
      activeCredential = next
      sourceCheckedAt = 0
    }
  }

  await loadActiveCredential()

  // Native pricing stays by default, so OpenCode reports what the traffic
  // would cost at API rates. `cost: "zero"` restores the subscription view.
  if (ctx.options?.cost === "zero") {
    registrations.push(
      await ctx.model.transform((editor) => {
        if (!activeCredential) return
        for (const model of editor.list(INTEGRATION_ID)) {
          editor.update(INTEGRATION_ID, String(model.id), (draft) => {
            draft.cost = []
          })
        }
      }),
    )
  }

  const eventController = new AbortController()
  const { signal } = eventController
  const subscribe = () =>
    ctx.event.subscribe({ signal })[Symbol.asyncIterator]()
  let eventIterator: ReturnType<typeof subscribe> | undefined

  const consumeEvents = async (): Promise<void> => {
    const iterator = subscribe()
    eventIterator = iterator
    try {
      while (true) {
        const next = await iterator.next()
        if (next.done) return
        const event = next.value
        if (
          event.type !== "credential.switched" ||
          event.data.integrationID !== INTEGRATION_ID
        ) {
          continue
        }
        try {
          await loadActiveCredential()
        } catch (error) {
          warn(
            "credential_reload_failed",
            `could not load the newly selected Anthropic credential, so Claude Code credentials are not applied until the next switch: ${errorMessage(error)}`,
          )
        }
        try {
          await ctx.model.reload()
        } catch (error) {
          log("model_reload_failed", { error: errorMessage(error) })
        }
      }
    } catch (error) {
      // The host's subscribe() ignores the abort signal, so an iterator
      // abandoned mid-stream has to be closed here, or every resubscribe
      // leaks one. A completed iterator needs nothing.
      await iterator.return?.().catch(() => {})
      if (!signal.aborted) {
        log("credential_event_failed", { error: errorMessage(error) })
      }
    }
  }

  // The host stream can fail or end while the service keeps running, and a
  // plugin that stops listening silently stops following account switches.
  const eventTask = (async () => {
    while (!signal.aborted) {
      await consumeEvents()
      await sleep(deps.eventResubscribeDelayMs, undefined, { signal }).catch(
        () => {
          // Aborted during the wait; the loop condition ends it.
        },
      )
    }
  })().catch((error) => {
    // Nothing awaits this until dispose, and an unhandled rejection would
    // take the whole service down.
    log("credential_event_failed", { error: errorMessage(error) })
  })

  return async () => {
    eventController.abort()
    try {
      await settle("event_iterator", async () => eventIterator?.return?.())
      await settle("event_task", () => eventTask)
      await settle("source_recheck", async () => pendingRecheck)
      for (let index = registrations.length - 1; index >= 0; index--) {
        await settle("registration", () => registrations[index].dispose())
      }
    } finally {
      closeLogger()
    }
  }
}

// `Plugin.define` is an identity function, so the type annotation gives the
// same checking without a runtime import. That keeps the host SDK out of
// consumers' installs. Every import from it in this package is a type.
const plugin: Plugin = {
  id: "griffinmartin.claude-auth",
  setup: setupClaudeAuth,
}

export default plugin
