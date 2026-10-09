import type { Credential } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  ClaudeAuthTerminalError,
  createOAuthCredential,
  type CredentialRefreshResult,
} from "./credentials.ts"
import plugin, {
  REQUIRED_HOST_VERSION,
  setupClaudeAuth,
  type PluginDependencies,
} from "./index.ts"
import type { ClaudeAccount } from "./keychain.ts"

type Hook = (event: never) => Promise<void> | void

interface MethodRegistration {
  integrationID: string
  method: {
    id: string
    type: "oauth"
    label: string
    form?: Array<unknown>
  }
  authorize: (answer: Record<string, string>) => Promise<{
    mode: "auto"
    url: string
    instructions: string
    callback: Promise<Credential.OAuth>
  }>
  refresh: (credential: Credential.OAuth) => Promise<Credential.OAuth>
  label: (credential: Credential.OAuth) => string | undefined
}

class EventSource {
  private queue: unknown[] = []
  private wake: (() => void) | undefined
  private honorSignal: boolean
  private failNext = false
  returnCount = 0
  subscribeCount = 0

  constructor(honorSignal = true) {
    this.honorSignal = honorSignal
  }

  push(event: unknown): void {
    this.queue.push(event)
    this.wake?.()
  }

  /** The next `next()` call rejects, as a dropped host stream would. */
  fail(): void {
    this.failNext = true
    this.wake?.()
  }

  subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown> {
    this.subscribeCount++
    // Closing an iterator ends that subscription only, as the host does. A
    // shared flag would make a resubscribed stream complete immediately.
    const self = { closed: false }
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<unknown>> => {
          while (
            this.queue.length === 0 &&
            !self.closed &&
            !this.failNext &&
            !(this.honorSignal && options?.signal?.aborted)
          ) {
            await new Promise<void>((resolve) => {
              this.wake = resolve
              if (this.honorSignal) {
                options?.signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                })
              }
            })
            this.wake = undefined
          }
          if (this.failNext) {
            this.failNext = false
            throw new Error("stream dropped")
          }
          if (self.closed || (this.honorSignal && options?.signal?.aborted)) {
            return { value: undefined, done: true }
          }
          return { value: this.queue.shift()!, done: false }
        },
        return: async (): Promise<IteratorResult<unknown>> => {
          this.returnCount++
          self.closed = true
          this.wake?.()
          return { value: undefined, done: true }
        },
      }),
    }
  }
}

// Real Keychain service names: credential metadata is validated on the way
// back in, so a fixture using an arbitrary name would not round-trip.
const PRIMARY = "Claude Code-credentials"
const ACCOUNT_A = "Claude Code-credentials-aaaaaaaa"
const ACCOUNT_B = "Claude Code-credentials-bbbbbbbb"

function account(source = PRIMARY, access = "access"): ClaudeAccount {
  return {
    label: `Claude Pro: ${source}`,
    source,
    credentials: {
      accessToken: access,
      refreshToken: `refresh-${access}`,
      expiresAt: Date.now() + 3600_000,
    },
  }
}

function oauth(source = PRIMARY, access = "access"): Credential.OAuth {
  return createOAuthCredential(account(source, access))
}

function keyCredential(): Credential.Value {
  return { type: "key", key: "api-key" }
}

function waitFor(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const run = () => {
      if (check()) return resolve()
      if (Date.now() - started > 1000) return reject(new Error("timed out"))
      setTimeout(run, 0)
    }
    run()
  })
}

function fakeContext(
  initial: Credential.Value | undefined,
  honorEventSignal = true,
) {
  let active = initial
  let integrationRegistration: MethodRegistration | undefined
  let modelTransform: ((draft: unknown) => void) | undefined
  const hooks = new Map<string, Hook>()
  const hookOptions = new Map<string, unknown>()
  const events = new EventSource(honorEventSignal)
  const nativeCost = [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }]
  const model = { providerID: "anthropic", id: "claude", cost: [...nativeCost] }
  const otherModel = {
    providerID: "other",
    id: "claude",
    cost: [...nativeCost],
  }
  const sourceModel = Object.freeze({
    ...model,
    cost: Object.freeze([...nativeCost]),
  })
  let resolveCount = 0
  let reloadCount = 0
  let disposeCount = 0
  let rejectNextResolve = false
  let rejectNextDispose = false
  const createRegistration = () => ({
    dispose: async () => {
      disposeCount++
      if (rejectNextDispose) {
        rejectNextDispose = false
        throw new Error("dispose failed")
      }
    },
  })

  const modelDraft = () => ({
    list: (providerID?: string) =>
      [model, otherModel].filter(
        (candidate) => !providerID || candidate.providerID === providerID,
      ),
    update: (
      providerID: string,
      modelID: string,
      update: (draft: typeof model) => void,
    ) => {
      const target = [model, otherModel].find(
        (candidate) =>
          candidate.providerID === providerID && candidate.id === modelID,
      )
      if (target) update(target)
    },
    provider: {
      get: (providerID: string) =>
        providerID === "anthropic"
          ? { models: new Map([["claude", sourceModel]]) }
          : undefined,
    },
  })

  const context = {
    integration: {
      transform: async (callback: (draft: unknown) => void) => {
        callback({
          method: {
            update: (registration: MethodRegistration) => {
              integrationRegistration = registration
            },
          },
        })
        return createRegistration()
      },
      connection: {
        active: async () =>
          active
            ? active.type === "key" && active.key === "env"
              ? { type: "env", name: "ANTHROPIC_API_KEY" }
              : { type: "credential", id: "credential", label: "Anthropic" }
            : undefined,
        resolve: async () => {
          resolveCount++
          if (rejectNextResolve) {
            rejectNextResolve = false
            throw new Error("resolve failed")
          }
          return active
        },
      },
    },
    model: {
      transform: async (callback: (draft: unknown) => void) => {
        modelTransform = callback
        callback(modelDraft())
        return createRegistration()
      },
      reload: async () => {
        reloadCount++
        model.cost = [...nativeCost]
        otherModel.cost = [...nativeCost]
        modelTransform?.(modelDraft())
      },
    },
    session: {
      hook: async (name: string, callback: Hook, options: unknown) => {
        hooks.set(name, callback)
        hookOptions.set(name, options)
        return createRegistration()
      },
    },
    event: {
      subscribe: events.subscribe.bind(events),
    },
  } as unknown as Context

  return {
    context,
    events,
    hooks,
    hookOptions,
    model,
    otherModel,
    sourceModel,
    registration: () => integrationRegistration!,
    resolveCount: () => resolveCount,
    reloadCount: () => reloadCount,
    disposeCount: () => disposeCount,
    failNextResolve: () => {
      rejectNextResolve = true
    },
    failNextDispose: () => {
      rejectNextDispose = true
    },
    setActive: (credential: Credential.Value | undefined) => {
      active = credential
    },
  }
}

function dependencies(
  accounts: ClaudeAccount[],
  overrides: Partial<PluginDependencies> = {},
): Partial<PluginDependencies> {
  return {
    readAccounts: async () => accounts,
    adopt: async (credential) => ({ credential, kind: "unchanged" }),
    refresh: async (credential) => ({ credential, kind: "unchanged" }),
    // Past SOURCE_CACHE_TTL_MS, so the request hook's source re-check is live
    // by default. A clock frozen at 0 leaves `now - sourceCheckedAt` below the
    // window forever and silently disables adoption in every test.
    now: () => 30_000,
    eventResubscribeDelayMs: 0,
    ...overrides,
  }
}

function contextEvent(tools: Record<string, unknown> = {}) {
  return {
    sessionID: "session",
    system: [{ type: "text", text: "OpenCode system" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools,
  }
}

function requestEvent(body = "request-body") {
  return {
    sessionID: "session",
    model: { id: "claude-sonnet-4-5" },
    request: new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body,
    }),
  }
}

describe("v2 plugin contract", () => {
  it("exports one Promise plugin definition", () => {
    assert.equal(plugin.id, "griffinmartin.claude-auth")
    assert.equal(typeof plugin.setup, "function")
    assert.equal("auth" in plugin, false)
  })

  it("fails clearly when the pinned host capabilities are absent", async () => {
    await assert.rejects(
      setupClaudeAuth({} as Context, dependencies([])),
      new RegExp(`${REQUIRED_HOST_VERSION}.*integration\\.transform`),
    )
  })

  it("closes the event iterator when the pinned adapter ignores abort", async () => {
    const fake = fakeContext(undefined, false)
    const cleanup = await setupClaudeAuth(fake.context, dependencies([]))
    await cleanup?.()
    assert.equal(fake.events.returnCount, 1)
    assert.equal(fake.disposeCount(), 8)
  })

  it("registers the exact auto authorization and persisted account label", async () => {
    const accounts = [
      account(ACCOUNT_A, "one-access"),
      account(ACCOUNT_B, "two-access"),
    ]
    const fake = fakeContext(undefined)
    const cleanup = await setupClaudeAuth(fake.context, dependencies(accounts))
    const registration = fake.registration()

    assert.equal(registration.integrationID, "anthropic")
    assert.deepEqual(registration.method, {
      id: "claude-code",
      type: "oauth",
      label: "Import Claude Code subscription",
      form: [
        {
          key: "account",
          type: "string",
          title: "Claude Code account",
          required: true,
          options: [
            { value: ACCOUNT_A, label: `Claude Pro: ${ACCOUNT_A}` },
            { value: ACCOUNT_B, label: `Claude Pro: ${ACCOUNT_B}` },
          ],
        },
      ],
    })
    const authorization = await registration.authorize({ account: ACCOUNT_B })
    assert.equal(authorization.mode, "auto")
    assert.equal(authorization.url, "")
    assert.ok(authorization.instructions.length > 0)
    assert.ok(authorization.callback instanceof Promise)
    const credential = await authorization.callback
    assert.equal(credential.access, "two-access")
    assert.equal(registration.label(credential), `Claude Pro: ${ACCOUNT_B}`)
    await cleanup?.()
  })

  it("scopes all hooks to Anthropic and never resolves on the hot path", async () => {
    const fake = fakeContext(oauth())
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()]),
    )
    assert.deepEqual(
      [...fake.hooks.keys()],
      [
        "context",
        "compaction",
        "generate",
        "title",
        "http.request",
        "http.response",
      ],
    )
    for (const options of fake.hookOptions.values()) {
      assert.deepEqual(options, { providerID: "anthropic" })
    }
    assert.equal(fake.resolveCount(), 1)
    const request = requestEvent()
    await fake.hooks.get("http.request")!(request as never)
    assert.equal(fake.resolveCount(), 1)
    await cleanup?.()
    assert.equal(fake.disposeCount(), 8)
  })

  it("applies subscription identity to every model request kind", async () => {
    const fake = fakeContext(oauth())
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()]),
    )
    try {
      for (const hook of ["context", "compaction", "generate", "title"]) {
        const event = contextEvent({ read: {} })
        if (hook === "title") delete (event as { tools?: unknown }).tools
        await fake.hooks.get(hook)!(event as never)
        assert.match(event.system[0].text, /^x-anthropic-billing-header:/)
        assert.equal(
          event.system[1].text,
          "You are Claude Code, Anthropic's official CLI for Claude.",
        )
        assert.match(event.messages[0].content[0].text, /OpenCode system/)
      }
    } finally {
      await cleanup?.()
    }
  })

  it("keeps primary fallback aliases when an auxiliary request runs", async () => {
    const fake = fakeContext(oauth())
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()]),
    )
    try {
      await fake.hooks.get("context")!(contextEvent({ read: {} }) as never)
      await fake.hooks.get("title")!({
        ...contextEvent(),
        tools: undefined,
      } as never)
      await fake.hooks.get("generate")!(contextEvent({ edit: {} }) as never)
      for (const [kind, name, expected] of [
        ["primary", "mcp_Read", "read"],
        ["generate", "mcp_Edit", "edit"],
        ["title", "mcp_Read", "mcp_Read"],
      ]) {
        const event = {
          ...requestEvent(),
          kind,
          response: Response.json({ content: [{ type: "tool_use", name }] }),
        }
        await fake.hooks.get("http.response")!(event as never)
        const body = await event.response.json()
        assert.equal(body.content[0].name, expected)
      }
    } finally {
      await cleanup?.()
    }
  })

  it("zeroes only active Anthropic model costs and restores pricing after a switch without a catalog API", async () => {
    const fake = fakeContext(oauth())
    assert.equal("catalog" in fake.context, false)
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()]),
    )
    assert.deepEqual(fake.model.cost, [])
    assert.equal(fake.otherModel.cost.length, 1)
    assert.equal(fake.sourceModel.cost.length, 1)

    fake.setActive(keyCredential())
    fake.events.push({
      type: "credential.switched",
      data: { integrationID: "anthropic", credentialID: "key" },
    })
    await waitFor(() => fake.reloadCount() === 1)
    assert.equal(fake.resolveCount(), 2)
    assert.equal(fake.model.cost.length, 1)
    assert.equal(fake.otherModel.cost.length, 1)
    assert.equal(fake.sourceModel.cost.length, 1)
    await cleanup?.()
  })

  it("fails a switch closed and continues processing later switches", async () => {
    const fake = fakeContext(oauth())
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()]),
    )
    fake.failNextResolve()
    fake.setActive(keyCredential())
    fake.events.push({
      type: "credential.switched",
      data: { integrationID: "anthropic", credentialID: "key" },
    })
    await waitFor(() => fake.reloadCount() === 1)
    assert.equal(fake.model.cost.length, 1)
    const failedRequest = requestEvent()
    const originalRequest = failedRequest.request
    await fake.hooks.get("http.request")!(failedRequest as never)
    assert.equal(failedRequest.request, originalRequest)

    fake.setActive(oauth(PRIMARY, "replacement"))
    fake.events.push({
      type: "credential.switched",
      data: { integrationID: "anthropic", credentialID: "replacement" },
    })
    await waitFor(() => fake.reloadCount() === 2)
    assert.deepEqual(fake.model.cost, [])
    const recoveredRequest = requestEvent()
    await fake.hooks.get("http.request")!(recoveredRequest as never)
    assert.notEqual(recoveredRequest.request.headers.get("authorization"), null)
    await cleanup?.()
  })

  it("surfaces a startup discovery failure from /connect instead of 'no credentials'", async () => {
    const fake = fakeContext(undefined)
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([], {
        readAccounts: async () => {
          throw new Error("macOS Keychain is locked")
        },
      }),
    )
    await assert.rejects(
      fake.registration().authorize({}),
      /Keychain is locked/,
    )
    await cleanup?.()
  })

  it("re-checks the source once per cache window on the request path", async () => {
    const original = oauth(PRIMARY, "first")
    const rotated = oauth(PRIMARY, "second")
    const fake = fakeContext(original)
    let clock = 30_000
    let adoptCalls = 0
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()], {
        now: () => clock,
        adopt: async (credential): Promise<CredentialRefreshResult> => {
          adoptCalls++
          return adoptCalls === 2
            ? { credential: rotated, kind: "adopted" }
            : { credential, kind: "unchanged" }
        },
      }),
    )
    const hook = fake.hooks.get("http.request")!
    const first = requestEvent()
    await hook(first as never)
    assert.equal(adoptCalls, 1)
    assert.equal(first.request.headers.get("authorization"), "Bearer first")

    clock += 30_000
    const second = requestEvent()
    await hook(second as never)
    assert.equal(adoptCalls, 2)
    assert.equal(second.request.headers.get("authorization"), "Bearer second")

    const third = requestEvent()
    await hook(third as never)
    assert.equal(adoptCalls, 2)
    assert.equal(third.request.headers.get("authorization"), "Bearer second")
    await cleanup?.()
  })

  it("resubscribes after the host event stream drops", async () => {
    const fake = fakeContext(oauth())
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()]),
    )
    assert.equal(fake.events.subscribeCount, 1)
    fake.events.fail()
    await waitFor(() => fake.events.subscribeCount === 2)

    fake.setActive(keyCredential())
    fake.events.push({
      type: "credential.switched",
      data: { integrationID: "anthropic", credentialID: "key" },
    })
    await waitFor(() => fake.reloadCount() === 1)
    await cleanup?.()
    assert.equal(fake.events.subscribeCount, 2)
  })

  it("finishes teardown when one registration fails to dispose", async () => {
    const fake = fakeContext(oauth())
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()]),
    )
    fake.failNextDispose()
    await cleanup?.()
    assert.equal(fake.disposeCount(), 8)
  })

  it("leaves key, environment, foreign OAuth, and absent connections untouched", async () => {
    const values: Array<Credential.Value | undefined> = [
      keyCredential(),
      { type: "key", key: "env" },
      {
        ...oauth(),
        methodID: "foreign" as Credential.OAuth["methodID"],
      },
      undefined,
    ]
    for (const value of values) {
      const fake = fakeContext(value)
      const cleanup = await setupClaudeAuth(
        fake.context,
        dependencies([account()]),
      )
      const context = contextEvent()
      fake.hooks.get("context")!(context as never)
      assert.deepEqual(context.system, [
        { type: "text", text: "OpenCode system" },
      ])
      const request = requestEvent()
      const original = request.request
      await fake.hooks.get("http.request")!(request as never)
      assert.equal(request.request, original)
      assert.equal(fake.model.cost.length, 1)
      await cleanup?.()
    }
  })
})

describe("401 recovery contract", () => {
  it("replays two independently buffered bodies after adoption and refresh", async () => {
    const original = oauth(PRIMARY, "first")
    const adopted = oauth(PRIMARY, "second")
    const refreshed = oauth(PRIMARY, "third")
    const fake = fakeContext(original)
    let adoptCalls = 0
    const bodies: string[] = []
    const authorizations: Array<string | null> = []
    let fetches = 0
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()], {
        adopt: async (credential): Promise<CredentialRefreshResult> => {
          adoptCalls++
          // Call 1 is the request hook's source re-check; call 2 is the one
          // 401 recovery makes.
          return adoptCalls === 2
            ? { credential: adopted, kind: "adopted" }
            : { credential, kind: "unchanged" }
        },
        refresh: async () => ({ credential: refreshed, kind: "refreshed" }),
        fetch: async (request) => {
          const value =
            request instanceof Request ? request : new Request(request)
          bodies.push(await value.text())
          authorizations.push(value.headers.get("authorization"))
          fetches++
          return new Response(fetches === 1 ? "still unauthorized" : "ok", {
            status: fetches === 1 ? 401 : 200,
          })
        },
      }),
    )

    const request = requestEvent("complete-body")
    await fake.hooks.get("http.request")!(request as never)
    assert.equal(await request.request.clone().text(), "complete-body")
    const responseEvent = {
      request: request.request,
      response: new Response("unauthorized", { status: 401 }),
    }
    await fake.hooks.get("http.response")!(responseEvent as never)

    assert.equal(responseEvent.response.status, 200)
    assert.deepEqual(bodies, ["complete-body", "complete-body"])
    assert.deepEqual(authorizations, ["Bearer second", "Bearer third"])
    assert.equal(fake.resolveCount(), 1)
    await cleanup?.()
  })

  it("turns a transient refresh into an explicitly retryable 429", async () => {
    const original = oauth()
    const fake = fakeContext(original)
    let fetches = 0
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()], {
        refresh: async () => ({ credential: original, kind: "transient" }),
        fetch: async () => {
          fetches++
          return new Response("unexpected")
        },
      }),
    )
    const request = requestEvent()
    await fake.hooks.get("http.request")!(request as never)
    const responseEvent = {
      request: request.request,
      response: new Response("unauthorized", { status: 401 }),
    }
    await fake.hooks.get("http.response")!(responseEvent as never)
    assert.equal(responseEvent.response.status, 429)
    assert.equal(responseEvent.response.headers.get("x-should-retry"), "true")
    assert.equal(responseEvent.response.headers.get("retry-after"), "5")
    assert.equal(fetches, 0)
    await cleanup?.()
  })

  it("surfaces the original 401 when recovery throws", async () => {
    const fake = fakeContext(oauth())
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()], {
        refresh: async () => {
          throw new ClaudeAuthTerminalError()
        },
      }),
    )
    const request = requestEvent()
    await fake.hooks.get("http.request")!(request as never)
    const responseEvent = {
      request: request.request,
      response: new Response("unauthorized", { status: 401 }),
    }
    // A terminal credential error must not escape the hook: the 401 is a
    // well-formed provider error the SDK already knows how to report.
    await fake.hooks.get("http.response")!(responseEvent as never)
    assert.equal(responseEvent.response.status, 401)
    assert.equal(await responseEvent.response.text(), "unauthorized")
    await cleanup?.()
  })

  it("does not replay a turn the caller already aborted", async () => {
    const fake = fakeContext(oauth())
    let refreshes = 0
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()], {
        refresh: async (credential) => {
          refreshes++
          return { credential, kind: "unchanged" }
        },
      }),
    )
    const controller = new AbortController()
    const request = {
      sessionID: "session",
      model: { id: "claude-sonnet-4-5" },
      request: new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: "body",
        signal: controller.signal,
      }),
    }
    await fake.hooks.get("http.request")!(request as never)
    controller.abort()
    const responseEvent = {
      request: request.request,
      response: new Response("unauthorized", { status: 401 }),
    }
    await fake.hooks.get("http.response")!(responseEvent as never)
    assert.equal(responseEvent.response.status, 401)
    assert.equal(refreshes, 0)
    await cleanup?.()
  })

  it("keeps the host refresh callback and the request path in step", async () => {
    const original = oauth(PRIMARY, "first")
    const rotated = oauth(PRIMARY, "second")
    const fake = fakeContext(original)
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()], {
        refresh: async () => ({ credential: rotated, kind: "refreshed" }),
      }),
    )
    const returned = await fake.registration().refresh(original)
    assert.equal(returned.access, "second")

    const request = requestEvent()
    await fake.hooks.get("http.request")!(request as never)
    assert.equal(
      request.request.headers.get("authorization"),
      "Bearer second",
      "the request path must use the credential the host just refreshed",
    )
    await cleanup?.()
  })
})

const ALIASED_SSE =
  'event: content_block_start\ndata: {"type":"tool_use","name":"mcp_Shell"}\n\n'

describe("tool name restoration contract", () => {
  it("returns OpenCode's own tool names on a successful response", async () => {
    const fake = fakeContext(oauth())
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()]),
    )
    const request = requestEvent(JSON.stringify({ tools: [{ name: "shell" }] }))
    await fake.hooks.get("http.request")!(request as never)
    assert.match(await request.request.clone().text(), /"mcp_Shell"/)

    const responseEvent = {
      sessionID: "session",
      request: request.request,
      response: new Response(ALIASED_SSE),
    }
    await fake.hooks.get("http.response")!(responseEvent as never)
    const text = await responseEvent.response.text()
    assert.match(text, /"name":"shell"/)
    assert.doesNotMatch(text, /mcp_Shell/)
    await cleanup?.()
  })

  it("restores the replayed response after a 401 recovery", async () => {
    const fake = fakeContext(oauth(PRIMARY, "first"))
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()], {
        refresh: async () => ({
          credential: oauth(PRIMARY, "second"),
          kind: "refreshed",
        }),
        fetch: async () => new Response(ALIASED_SSE, { status: 200 }),
      }),
    )
    const request = requestEvent(JSON.stringify({ tools: [{ name: "shell" }] }))
    await fake.hooks.get("http.request")!(request as never)
    const responseEvent = {
      sessionID: "session",
      request: request.request,
      response: new Response("unauthorized", { status: 401 }),
    }
    await fake.hooks.get("http.response")!(responseEvent as never)
    assert.equal(responseEvent.response.status, 200)
    assert.match(await responseEvent.response.text(), /"name":"shell"/)
    await cleanup?.()
  })

  it("keeps restoring when the request hook re-runs on its own output", async () => {
    const fake = fakeContext(oauth())
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()]),
    )
    const request = requestEvent(JSON.stringify({ tools: [{ name: "shell" }] }))
    await fake.hooks.get("http.request")!(request as never)
    await fake.hooks.get("http.request")!(request as never)
    assert.match(await request.request.clone().text(), /"mcp_Shell"/)

    const responseEvent = {
      sessionID: "session",
      request: request.request,
      response: new Response(ALIASED_SSE),
    }
    await fake.hooks.get("http.response")!(responseEvent as never)
    assert.match(await responseEvent.response.text(), /"name":"shell"/)
    await cleanup?.()
  })

  it("falls back to the session's registered tools for an unknown request", async () => {
    const fake = fakeContext(oauth())
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()]),
    )
    fake.hooks.get("context")!(
      contextEvent({ shell: { description: "run", input: {} } }) as never,
    )
    const request = requestEvent(JSON.stringify({ tools: [{ name: "shell" }] }))
    await fake.hooks.get("http.request")!(request as never)

    const responseEvent = {
      sessionID: "session",
      request: request.request.clone(),
      response: new Response(ALIASED_SSE),
    }
    await fake.hooks.get("http.response")!(responseEvent as never)
    assert.match(await responseEvent.response.text(), /"name":"shell"/)

    const otherSession = {
      sessionID: "other",
      request: request.request.clone(),
      response: new Response(ALIASED_SSE),
    }
    await fake.hooks.get("http.response")!(otherSession as never)
    assert.match(await otherSession.response.text(), /mcp_Shell/)
    await cleanup?.()
  })
})
