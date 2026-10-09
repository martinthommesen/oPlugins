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
  buildAccountForm,
  credentialLabel,
  type CredentialRefreshResult,
  INTEGRATION_ID,
  isClaudeCodeCredential,
  METHOD_ID,
  readMetadata,
  refreshClaudeCredentialDetailed,
  refreshRetryAfterSeconds,
} from "./credentials.ts"
import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"
import { closeLogger, errorMessage, initLogger, log } from "./logger.ts"
import {
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
 * Request contexts whose wire aliases are retained. Only a fallback for when the
 * per-request state is unavailable, so evicting the coldest entry costs at
 * most one response's tool-name restoration in a session that went quiet.
 */
const MAX_TRACKED_CONTEXTS = 512

/**
 * The host build this release targets. The single source for the pin: the
 * compatibility error, the smoke test's CLI install, and its version check
 * all read it, so bumping the host is one edit here plus `package.json`.
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

function aliasKey(
  sessionID: string,
  kind: SessionRequestKind = "primary",
): string {
  return `${sessionID}:${kind}`
}

export interface PluginDependencies {
  readAccounts: () => Promise<ClaudeAccount[]>
  adopt: (credential: Credential.OAuth) => Promise<CredentialRefreshResult>
  refresh: (credential: Credential.OAuth) => Promise<CredentialRefreshResult>
  fetch: typeof fetch
  now: () => number
  /** Wait before re-subscribing after the host event stream fails or ends. */
  eventResubscribeDelayMs: number
}

/**
 * Run a teardown step, logging instead of aborting the steps after it. The
 * timeout matters as much as the catch: a step that never settles would
 * otherwise strand every later step, including closing the log.
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
    // Leave no pending timer behind: the race does not cancel the loser.
    timer.abort()
  }
}

/** Release a response this plugin is dropping, so undici can reclaim it now. */
function discard(response: Response | undefined): void {
  if (!response || response.bodyUsed || !response.body) return
  void response.body.cancel().catch(() => {
    // Already errored or locked; nothing left to release.
  })
}

/** @internal Test seam for the host-facing plugin contract. */
export async function setupClaudeAuth(
  ctx: Context,
  overrides: Partial<PluginDependencies> = {},
) {
  const deps: PluginDependencies = {
    readAccounts: readAllClaudeAccounts,
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
  // its cause instead of reporting that no credentials exist.
  let startupAccounts: ClaudeAccount[] = []
  let startupError: unknown
  try {
    startupAccounts = await deps.readAccounts()
  } catch (error) {
    startupError = error
    log("account_discovery_failed", { error: errorMessage(error) })
  }

  let activeCredential: Credential.OAuth | null = null
  let sourceCheckedAt = 0
  const requestStates = new WeakMap<Request, RequestState>()
  // Aliases the registered tools carry on the wire, per session. Restoration
  // falls back to this when the host hands the response hook a Request other
  // than the one the request hook produced. Bounded, because the plugin lives
  // in a server that outlives any individual session and the host has no
  // session-ended signal to unsubscribe from.
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

  /**
   * Adopt `next` in place of `previous`. `recheckSource` forces the next
   * request to re-read the source; a caller that just read it says false.
   */
  const updateActive = (
    previous: Credential.OAuth,
    next: Credential.OAuth,
    { recheckSource = true } = {},
  ): void => {
    if (sameCredential(activeCredential, previous)) activeCredential = next
    if (recheckSource) sourceCheckedAt = 0
  }

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
            readAccounts: deps.readAccounts,
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

  const loadActiveCredential = async (): Promise<void> => {
    activeCredential = null
    sourceCheckedAt = 0
    const connection = await ctx.integration.connection.active(INTEGRATION_ID)
    const credential = connection
      ? await ctx.integration.connection.resolve(connection)
      : undefined
    activeCredential = isClaudeCodeCredential(credential) ? credential : null
  }

  await loadActiveCredential()

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

  // Auxiliary model calls need the same subscription identity as the agent
  // loop. Keep their fallback aliases separate: a title can run concurrently.
  for (const hook of ["context", "compaction", "generate", "title"] as const) {
    registrations.push(
      await ctx.session.hook(
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

  registrations.push(
    await ctx.session.hook(
      "http.request",
      async (event: SessionHttpRequest) => {
        let credential = activeCredential
        if (!credential) return

        const now = deps.now()
        if (now - sourceCheckedAt >= SOURCE_CACHE_TTL_MS) {
          sourceCheckedAt = now
          const adopted = await deps.adopt(credential)
          if (adopted.kind === "adopted") {
            // The source was just read, so this window stays open.
            updateActive(credential, adopted.credential, {
              recheckSource: false,
            })
            credential = adopted.credential
          }
        }

        const transformed = await transformRequest(
          event,
          credential,
          requestStates.get(event.request)?.snapshot.originalByAlias,
        )
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

    const adopted = await deps.adopt(credential)
    if (adopted.kind === "adopted") {
      updateActive(credential, adopted.credential)
      credential = adopted.credential
      response = await replay(credential)
      if (response.status !== 401) return response
    }

    const refreshed = await deps.refresh(credential)
    if (refreshed.kind === "transient") {
      return retryableRefreshResponse(refreshRetryAfterSeconds(credential))
    }
    updateActive(credential, refreshed.credential)
    if (refreshed.credential.access !== credential.access) {
      response = await replay(refreshed.credential)
    }
    return response
  }

  /**
   * Recovery is best-effort. A terminal credential error, an aborted turn, or
   * a failed replay all surface better as the original 401 — which the SDK
   * already knows how to report — than as an exception escaping the hook.
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
    }
    for (const response of [original, ...opened]) {
      if (response !== resolved) discard(response)
    }
    return resolved
  }

  registrations.push(
    await ctx.session.hook(
      "http.response",
      async (event: SessionHttpResponse) => {
        const state = requestStates.get(event.request)
        if (!state) {
          // The host handed back a Request other than the one the request
          // hook produced, so 401 recovery is skipped for this turn. Tool
          // names still restore from the session fallback, which makes the
          // degradation invisible without this.
          log("request_state_missing", { sessionID: event.sessionID })
        }
        const originalByAlias =
          state?.snapshot.originalByAlias ??
          sessionAliases.get(aliasKey(event.sessionID, event.kind))
        if (!originalByAlias) return

        // The plugin's own retryable 429 has no aliases to restore, so the
        // rewrite below passes it through without a match.
        const resolved =
          state && event.response.status === 401
            ? await recoverUnauthorized(event.response, state)
            : event.response
        event.response = restoreResponseToolNames(resolved, originalByAlias)
      },
      { providerID: INTEGRATION_ID },
    ),
  )

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
          log("credential_reload_failed", { error: errorMessage(error) })
        }
        try {
          await ctx.model.reload()
        } catch (error) {
          log("model_reload_failed", { error: errorMessage(error) })
        }
      }
    } catch (error) {
      // The host's subscribe() ignores the abort signal, so an iterator
      // abandoned mid-stream has to be closed here or every resubscribe
      // strands one. A completed iterator needs nothing.
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
// consumers' installs: every other import in this package is a type.
const plugin: Plugin = {
  id: "griffinmartin.claude-auth",
  setup: setupClaudeAuth,
}

export default plugin
