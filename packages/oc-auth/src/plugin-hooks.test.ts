import { Effect, Struct } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import FakeCatalog from "./fake-catalog.test-support.ts"
import FakeConnection from "./fake-connection.test-support.ts"
import FakeHooks from "./fake-hooks.test-support.ts"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"
import fakeHost from "./fake-host.test-support.ts"
import scenario from "./plugin-scenario.test-support.ts"
import sessionContext from "./session-context.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<typeof scenario.onHost>> | Scope.Scope
  >
}

/* Past the cache window, so the request path re-checks the credential store. */
const AFTER_CACHE_WINDOW = 30_000,
  ANTHROPIC_ONLY = '{"providerID":"anthropic"}',
  BILLING_HEADER = /^x-anthropic-billing-header:/u,
  FIRST_ARGUMENT = 0,
  /** The model requests that carry the subscription identity. */
  IDENTITY_HOOKS = ["context", "compaction", "generate", "title"] as const,
  NATIVE = 1,
  ONE_RESOLVE = 1,
  /* A response carrying one tool call under `name`. */
  callOf = (name: string): Response =>
    Response.json({
      content: [{ id: "one", input: {}, name, type: "tool_use" }],
      type: "message",
    }),
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

test.layer(ours)("plugin hooks", (it: Tests) => {
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
      }),
  )
})

test.layer(ours)("plugin pricing", (it: Tests) => {
  it.effect("keeps native model pricing by default", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* fakeHost.setUp

      expect(yield* (yield* FakeCatalog).costs).toStrictEqual({
        anthropic: NATIVE,
        other: NATIVE,
      })
    }),
  )
})

describe("plugin identity", () => {
  // One block per request, so each test sets up a plugin of its own.
  for (const name of IDENTITY_HOOKS) {
    test.layer(ours)((it: Tests) => {
      it.effect(
        `applies subscription identity to the ${name} model request`,
        () =>
          Effect.gen(function* run() {
            expect.hasAssertions()
            yield* fakeHost.setUp

            const event = scenario.contextEvent()

            yield* (yield* FakeHooks).fire(name, event)

            expect(event.system.map((part) => part.text)).toStrictEqual([
              expect.stringMatching(BILLING_HEADER),
              sessionContext.systemIdentity,
            ])
          }),
      )
    })
  }
})

test.layer(ours)("plugin aliases for auxiliary requests", (it: Tests) => {
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
      }),
  )
})
