import type { Credential } from "@opencode-ai/plugin"
import type { Context } from "@opencode-ai/plugin/promise/plugin"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createOAuthCredential,
  type CredentialRefreshResult,
} from "./credentials.ts"
import plugin, { setupClaudeAuth, type PluginDependencies } from "./index.ts"
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
  private stopped = false
  private honorSignal: boolean
  returnCount = 0

  constructor(honorSignal = true) {
    this.honorSignal = honorSignal
  }

  push(event: unknown): void {
    this.queue.push(event)
    this.wake?.()
  }

  subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<unknown>> => {
          while (
            this.queue.length === 0 &&
            !this.stopped &&
            !(this.honorSignal && options?.signal?.aborted)
          ) {
            await new Promise<void>((resolve) => {
              this.wake = resolve
              if (this.honorSignal) {
                options?.signal?.addEventListener("abort", resolve, {
                  once: true,
                })
              }
            })
            this.wake = undefined
          }
          if (this.stopped || (this.honorSignal && options?.signal?.aborted)) {
            return { value: undefined, done: true }
          }
          return { value: this.queue.shift()!, done: false }
        },
        return: async (): Promise<IteratorResult<unknown>> => {
          this.returnCount++
          this.stopped = true
          this.wake?.()
          return { value: undefined, done: true }
        },
      }),
    }
  }
}

function account(source = "source", access = "access"): ClaudeAccount {
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

function oauth(source = "source", access = "access"): Credential.OAuth {
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
  let catalogTransform: ((draft: unknown) => void) | undefined
  const hooks = new Map<string, Hook>()
  const hookOptions = new Map<string, unknown>()
  const events = new EventSource(honorEventSignal)
  const nativeCost = [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }]
  const model = { cost: [...nativeCost] }
  let resolveCount = 0
  let reloadCount = 0
  let disposeCount = 0
  let rejectNextResolve = false
  const createRegistration = () => ({
    dispose: async () => {
      disposeCount++
    },
  })

  const catalogDraft = () => ({
    provider: {
      get: (providerID: string) =>
        providerID === "anthropic"
          ? { models: new Map([["claude", model]]) }
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
    catalog: {
      transform: async (callback: (draft: unknown) => void) => {
        catalogTransform = callback
        callback(catalogDraft())
        return createRegistration()
      },
      reload: async () => {
        reloadCount++
        model.cost = [...nativeCost]
        catalogTransform?.(catalogDraft())
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
    registration: () => integrationRegistration!,
    resolveCount: () => resolveCount,
    reloadCount: () => reloadCount,
    disposeCount: () => disposeCount,
    failNextResolve: () => {
      rejectNextResolve = true
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
    readAccounts: () => accounts,
    adopt: (credential) => ({ credential, kind: "unchanged" }),
    refresh: async (credential) => ({ credential, kind: "unchanged" }),
    now: () => 0,
    ...overrides,
  }
}

function contextEvent() {
  return {
    system: [{ type: "text", text: "OpenCode system" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: {},
  }
}

function requestEvent(body = "request-body") {
  return {
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
      /beta-18381.*integration\.transform/,
    )
  })

  it("closes the event iterator when the pinned adapter ignores abort", async () => {
    const fake = fakeContext(undefined, false)
    const cleanup = await setupClaudeAuth(fake.context, dependencies([]))
    await cleanup?.()
    assert.equal(fake.events.returnCount, 1)
    assert.equal(fake.disposeCount(), 5)
  })

  it("registers the exact auto authorization and persisted account label", async () => {
    const accounts = [
      account("one", "one-access"),
      account("two", "two-access"),
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
            { value: "one", label: "Claude Pro: one" },
            { value: "two", label: "Claude Pro: two" },
          ],
        },
      ],
    })
    const authorization = await registration.authorize({ account: "two" })
    assert.equal(authorization.mode, "auto")
    assert.equal(authorization.url, "")
    assert.ok(authorization.instructions.length > 0)
    assert.ok(authorization.callback instanceof Promise)
    const credential = await authorization.callback
    assert.equal(credential.access, "two-access")
    assert.equal(registration.label(credential), "Claude Pro: two")
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
      ["context", "http.request", "http.response"],
    )
    for (const options of fake.hookOptions.values()) {
      assert.deepEqual(options, { providerID: "anthropic" })
    }
    assert.equal(fake.resolveCount(), 1)
    const request = requestEvent()
    await fake.hooks.get("http.request")!(request as never)
    assert.equal(fake.resolveCount(), 1)
    await cleanup?.()
    assert.equal(fake.disposeCount(), 5)
  })

  it("zeroes subscription costs and restores native costs after a switch", async () => {
    const fake = fakeContext(oauth())
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()]),
    )
    assert.deepEqual(fake.model.cost, [])

    fake.setActive(keyCredential())
    fake.events.push({
      type: "credential.switched",
      data: { integrationID: "anthropic", credentialID: "key" },
    })
    await waitFor(() => fake.reloadCount() === 1)
    assert.equal(fake.resolveCount(), 2)
    assert.equal(fake.model.cost.length, 1)
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

    fake.setActive(oauth("source", "replacement"))
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
    const original = oauth("source", "first")
    const adopted = oauth("source", "second")
    const refreshed = oauth("source", "third")
    const fake = fakeContext(original)
    let adoptCalls = 0
    const bodies: string[] = []
    const authorizations: Array<string | null> = []
    let fetches = 0
    const cleanup = await setupClaudeAuth(
      fake.context,
      dependencies([account()], {
        adopt: (credential): CredentialRefreshResult => {
          adoptCalls++
          return adoptCalls === 1
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
    assert.ok(responseEvent.response.headers.get("retry-after"))
    assert.equal(fetches, 0)
    await cleanup?.()
  })
})
