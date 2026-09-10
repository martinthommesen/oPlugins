import { Plugin, type Credential } from "@opencode-ai/plugin"
import type { Context } from "@opencode-ai/plugin/promise/plugin"
import type {
  SessionContext,
  SessionHttpRequest,
  SessionHttpResponse,
} from "@opencode-ai/plugin/promise/session"
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
import { closeLogger, initLogger, log } from "./logger.ts"
import {
  buildRequestFromSnapshot,
  restoreResponseToolNames,
  transformContext,
  transformRequest,
  type RequestSnapshot,
} from "./transforms.ts"

const SOURCE_CACHE_TTL_MS = 30_000

interface RequestState {
  credential: Credential.OAuth
  snapshot: RequestSnapshot
}

function assertCapabilities(ctx: Context): void {
  const capabilities: Array<[string, unknown]> = [
    ["integration.transform", ctx.integration?.transform],
    ["integration.connection.active", ctx.integration?.connection?.active],
    ["integration.connection.resolve", ctx.integration?.connection?.resolve],
    ["catalog.transform", ctx.catalog?.transform],
    ["catalog.reload", ctx.catalog?.reload],
    ["event.subscribe", ctx.event?.subscribe],
    ["session.hook", ctx.session?.hook],
  ]
  const missing = capabilities
    .filter(([, value]) => typeof value !== "function")
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(
      `opencode-claude-auth requires the OpenCode v0.0.0-beta-18381 Promise plugin API (missing: ${missing.join(", ")})`,
    )
  }
}

function sameCredential(
  left: Credential.OAuth | null,
  right: Credential.OAuth,
): boolean {
  if (!left) return false
  return (
    left.access === right.access &&
    readMetadata(left)?.source === readMetadata(right)?.source &&
    readMetadata(left)?.configDir === readMetadata(right)?.configDir
  )
}

function retryableRefreshResponse(credential: Credential.OAuth): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "Claude token refresh is temporarily unavailable.",
      },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(refreshRetryAfterSeconds(credential)),
        "x-should-retry": "true",
      },
    },
  )
}

export interface PluginDependencies {
  readAccounts: () => ClaudeAccount[]
  adopt: (credential: Credential.OAuth) => CredentialRefreshResult
  refresh: (credential: Credential.OAuth) => Promise<CredentialRefreshResult>
  fetch: typeof fetch
  now: () => number
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
    ...overrides,
  }
  assertCapabilities(ctx)
  initLogger()

  let startupAccounts: ClaudeAccount[] = []
  try {
    startupAccounts = deps.readAccounts()
  } catch (error) {
    log("account_discovery_failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  let activeCredential: Credential.OAuth | null = null
  let sourceCheckedAt = 0
  const requestStates = new WeakMap<Request, RequestState>()
  const registrations: Array<{ dispose(): Promise<void> }> = []

  const updateActive = (
    previous: Credential.OAuth,
    next: Credential.OAuth,
  ): void => {
    if (sameCredential(activeCredential, previous)) activeCredential = next
    sourceCheckedAt = 0
  }

  registrations.push(
    await ctx.integration.transform((draft) => {
      const form = buildAccountForm(startupAccounts)
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_ID,
          type: "oauth",
          label: "Import Claude Code subscription",
          ...(form ? { form } : {}),
        },
        authorize: async (answer) => {
          const credential = authorizeAccount(startupAccounts, answer, {
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
    await ctx.catalog.transform((draft) => {
      if (!activeCredential) return
      const anthropic = draft.provider.get(INTEGRATION_ID)
      if (!anthropic) return
      for (const model of anthropic.models.values()) model.cost = []
    }),
  )

  registrations.push(
    await ctx.session.hook(
      "context",
      (event: SessionContext) => {
        if (activeCredential) transformContext(event)
      },
      { providerID: INTEGRATION_ID },
    ),
  )

  registrations.push(
    await ctx.session.hook(
      "http.request",
      async (event: SessionHttpRequest) => {
        let credential = activeCredential
        if (!credential) return

        const now = deps.now()
        if (now - sourceCheckedAt >= SOURCE_CACHE_TTL_MS) {
          sourceCheckedAt = now
          const adopted = deps.adopt(credential)
          if (adopted.kind === "adopted") {
            updateActive(credential, adopted.credential)
            credential = adopted.credential
          }
        }

        const transformed = await transformRequest(event, credential)
        event.request = transformed.request
        requestStates.set(transformed.request, {
          credential,
          snapshot: transformed.snapshot,
        })
      },
      { providerID: INTEGRATION_ID },
    ),
  )

  const recoverUnauthorized = async (
    original: Response,
    state: RequestState,
  ): Promise<Response> => {
    let credential = state.credential
    let response = original

    const adopted = deps.adopt(credential)
    if (adopted.kind === "adopted") {
      updateActive(credential, adopted.credential)
      credential = adopted.credential
      response = await deps.fetch(
        buildRequestFromSnapshot(state.snapshot, credential),
      )
      if (response.status !== 401) return response
    }

    const refreshed = await deps.refresh(credential)
    if (refreshed.kind === "transient") {
      return retryableRefreshResponse(credential)
    }
    updateActive(credential, refreshed.credential)
    if (refreshed.credential.access !== credential.access) {
      response = await deps.fetch(
        buildRequestFromSnapshot(state.snapshot, refreshed.credential),
      )
    }
    return response
  }

  registrations.push(
    await ctx.session.hook(
      "http.response",
      async (event: SessionHttpResponse) => {
        const state = requestStates.get(event.request)
        if (!state) return

        const resolved =
          event.response.status === 401
            ? await recoverUnauthorized(event.response, state)
            : event.response
        event.response = restoreResponseToolNames(
          resolved,
          state.snapshot.toolNames,
        )
      },
      { providerID: INTEGRATION_ID },
    ),
  )

  const eventController = new AbortController()
  const eventIterable = ctx.event.subscribe({
    signal: eventController.signal,
  })
  const eventIterator = eventIterable[Symbol.asyncIterator]()
  const eventTask = (async () => {
    try {
      while (true) {
        const next = await eventIterator.next()
        if (next.done) break
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
          log("credential_reload_failed", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
        try {
          await ctx.catalog.reload()
        } catch (error) {
          log("catalog_reload_failed", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } catch (error) {
      if (!eventController.signal.aborted) {
        log("credential_event_failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  })()

  return async () => {
    eventController.abort()
    await eventIterator.return?.()
    await eventTask
    for (let index = registrations.length - 1; index >= 0; index--) {
      await registrations[index].dispose()
    }
    closeLogger()
  }
}

const plugin = Plugin.define({
  id: "griffinmartin.claude-auth",
  setup: setupClaudeAuth,
})

export default plugin
