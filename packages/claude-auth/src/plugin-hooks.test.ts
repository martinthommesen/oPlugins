import { Effect, Struct } from "effect"
import { describe, expect, it } from "@effect/vitest"
import FakeCatalog from "./fake-catalog.test-support.ts"
import FakeConnection from "./fake-connection.test-support.ts"
import FakeHooks from "./fake-hooks.test-support.ts"
import { TestClock } from "effect/testing"
import fakeHost from "./fake-host.test-support.ts"
import scenario from "./plugin-scenario.test-support.ts"
import sessionContext from "./session-context.ts"

/* Past the source cache window, so the request path's re-check is live. */
const AFTER_CACHE_WINDOW = 30_000,
  ANTHROPIC_ONLY = '{"providerID":"anthropic"}',
  BILLING_HEADER = /^x-anthropic-billing-header:/u,
  FIRST_ARGUMENT = 0,
  NATIVE = 1,
  ONE_RESOLVE = 1,
  /* A response carrying one tool call under `name`. */
  callOf = (name: string): Response =>
    Response.json({ content: [{ name, type: "tool_use" }] }),
  /* The tool names a response restored to. */
  namesIn = (response: Response): Effect.Effect<string> =>
    Effect.promise(
      (): PromiseLike<{
        readonly content: readonly { readonly name: string }[]
      }> => response.json(),
    ).pipe(
      Effect.map((body) => body.content.map((block) => block.name).join(",")),
    ),
  ours = scenario.onHost(scenario.ours("access")),
  /* What a `kind` model call's response naming `name` restores to. */
  restoredName = (
    kind: Parameters<typeof scenario.respondAs>[typeof FIRST_ARGUMENT],
    name: string,
  ): Effect.Effect<string, never, FakeHooks> =>
    scenario
      .respondAs(kind, scenario.messages(), callOf(name))
      .pipe(Effect.flatMap((response) => namesIn(response)))

describe("plugin hooks", () => {
  it.effect(
    "scopes all hooks to Anthropic and never resolves on the hot path",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* TestClock.setTime(AFTER_CACHE_WINDOW)
        yield* fakeHost.setUp

        const connection = yield* FakeConnection,
          hooks = yield* FakeHooks,
          resolvesBefore = yield* connection.resolves

        yield* scenario.send(scenario.messages())

        expect(yield* hooks.names).toStrictEqual([
          "context",
          "compaction",
          "generate",
          "title",
          "http.request",
          "http.response",
        ])
        expect(new Set(yield* hooks.options)).toStrictEqual(
          new Set([ANTHROPIC_ONLY]),
        )
        expect([resolvesBefore, yield* connection.resolves]).toStrictEqual([
          ONE_RESOLVE,
          ONE_RESOLVE,
        ])
      }).pipe(Effect.provide(ours)),
  )
})

describe("plugin pricing", () => {
  it.effect("keeps native model pricing by default", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* fakeHost.setUp

      expect(yield* (yield* FakeCatalog).costs).toStrictEqual({
        anthropic: NATIVE,
        other: NATIVE,
      })
    }).pipe(Effect.provide(ours)),
  )
})

describe("plugin identity", () => {
  it.effect.each(["context", "compaction", "generate", "title"] as const)(
    "applies subscription identity to the %s model request",
    (name) =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* fakeHost.setUp

        const event = scenario.contextEvent()

        yield* (yield* FakeHooks).fire(name, event)

        expect(event.system.map((part) => part.text)).toStrictEqual([
          expect.stringMatching(BILLING_HEADER),
          sessionContext.systemIdentity,
        ])
      }).pipe(Effect.provide(ours)),
  )
})

describe("plugin aliases for auxiliary requests", () => {
  it.effect(
    "keeps primary fallback aliases when an auxiliary request runs",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* fakeHost.setUp

        const hooks = yield* FakeHooks

        yield* hooks.fire("context", scenario.contextEvent())
        yield* hooks.fire(
          "title",
          Struct.omit(scenario.contextEvent(), ["tools"]),
        )
        yield* hooks.fire("generate", scenario.contextEvent())

        expect([
          yield* restoredName("primary", "mcp_Read"),
          yield* restoredName("generate", "mcp_Edit"),
          yield* restoredName("title", "mcp_Read"),
        ]).toStrictEqual(["read", "edit", "mcp_Read"])
      }).pipe(Effect.provide(ours)),
  )
})
