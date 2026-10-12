import { Effect, Struct } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import FakeHooks from "./fake-hooks.test-support.ts"
import PluginRig from "./plugin-rig.test-support.ts"
import type { Vitest } from "@effect/vitest"
import fakeHost from "./fake-host.test-support.ts"
import scenario from "./plugin-scenario.test-support.ts"
import transformsSupport from "./request-transforms.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<typeof scenario.onHost>> | Scope.Scope
  >
}

const ALIASED_SSE =
    'event: content_block_start\ndata: {"type":"tool_use","name":"mcp_Shell"}\n\n',
  OK = 200,
  SHELL_BODY = JSON.stringify({ tools: [{ name: "shell" }] }),
  /* A response streaming a tool call under its wire alias. */
  aliased = (): Response => new Response(ALIASED_SSE),
  /* A response's body, as text. */
  bodyOf = (response: Request | Response): Effect.Effect<string> =>
    transformsSupport.bodyText(response),
  onOurs = scenario.onHost(scenario.ours("access")),
  /* A rig that refreshes to `second` and replays to an aliased stream. */
  replaying = scenario.onHost(
    scenario.ours("first"),
    Struct.assign(PluginRig.quiet, {
      fetch: () => Effect.succeed(new Response(ALIASED_SSE, { status: OK })),
      refresh: () => Effect.succeed(scenario.refreshed("second")),
    }),
  ),
  /* What an aliased response to `request`, in `session`, restores to. */
  restoredText = (
    request: Request,
    session = "session",
  ): Effect.Effect<string, never, FakeHooks> =>
    scenario
      .respond(request, aliased(), session)
      .pipe(Effect.flatMap((response) => bodyOf(response))),
  /* The body a request went out with. */
  sentBody = (request: Request): Effect.Effect<string> =>
    bodyOf(request.clone()),
  /* A context event whose session registered a shell tool. */
  shellContext = Struct.assign(transformsSupport.contextEvent(), {
    tools: { shell: { description: "run", input: {} } },
  })

describe("tool names on a successful response", () => {
  test.layer(onOurs)((it: Tests) => {
    it.effect(
      "returns OpenCode's own tool names on a successful response",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* fakeHost.setUp

          const outbound = yield* scenario.send(scenario.messages(SHELL_BODY)),
            sent = yield* sentBody(outbound),
            text = yield* restoredText(outbound)

          expect(sent).toMatch(/"mcp_Shell"/u)
          expect(text).toMatch(/"name":"shell"/u)
          expect(text).not.toMatch(/mcp_Shell/u)
        }),
    )
  })

  test.layer(onOurs)((it: Tests) => {
    it.effect(
      "keeps restoring when the request hook re-runs on its own output",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* fakeHost.setUp

          const firstPass = yield* scenario.send(scenario.messages(SHELL_BODY)),
            secondPass = yield* scenario.send(firstPass)

          expect(yield* sentBody(secondPass)).toMatch(/"mcp_Shell"/u)
          expect(yield* restoredText(secondPass)).toMatch(/"name":"shell"/u)
        }),
    )
  })
})

test.layer(replaying)("tool names after a 401 recovery", (it: Tests) => {
  it.effect("restores the replayed response after a 401 recovery", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* fakeHost.setUp

      const answered = yield* scenario.respond(
        yield* scenario.send(scenario.messages(SHELL_BODY)),
        scenario.unauthorized(),
      )

      expect(answered.status).toBe(OK)
      expect(yield* bodyOf(answered)).toMatch(/"name":"shell"/u)
    }),
  )
})

describe("tool names on an unknown request", () => {
  // No context hook ran, so only the request hook knows these aliases.
  test.layer(onOurs)((it: Tests) => {
    it.effect(
      "restores the aliases a request body carried on an unknown request",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* fakeHost.setUp

          const outbound = yield* scenario.send(scenario.messages(SHELL_BODY))

          expect(yield* restoredText(outbound.clone())).toMatch(
            /"name":"shell"/u,
          )
        }),
    )
  })

  test.layer(onOurs)((it: Tests) => {
    it.effect(
      "falls back to the session's registered tools for an unknown request",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* fakeHost.setUp
          yield* (yield* FakeHooks).fire("context", shellContext)

          const outbound = yield* scenario.send(scenario.messages(SHELL_BODY)),
            restoredHere = yield* restoredText(outbound.clone()),
            restoredThere = yield* restoredText(outbound.clone(), "other")

          expect(restoredHere).toMatch(/"name":"shell"/u)
          expect(restoredThere).toMatch(/mcp_Shell/u)
        }),
    )
  })
})
