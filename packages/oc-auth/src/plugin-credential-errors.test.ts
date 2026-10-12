import { Effect, Schema, Struct } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import ClaudeAuthRefreshExhaustedError from "./claude-auth-refresh-exhausted-error.ts"
import ClaudeAuthTerminalError from "./claude-auth-terminal-error.ts"
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

type Script = typeof PluginRig.quiet

const CONSECUTIVE_FAILURES = 10,
  /** What the user is told after ten network errors in a row. */
  EXHAUSTED_MESSAGE = ClaudeAuthRefreshExhaustedError.textFor(
    CONSECUTIVE_FAILURES,
    "network error",
  ),
  /** The API's own error shape, as the SDK reads it. */
  ErrorBody = Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({ message: Schema.String, type: Schema.String }),
      type: Schema.String,
    }),
  ),
  UNAUTHORIZED = 401,
  /* A host whose refresh fails with `failure`. */
  didFail = (
    failure: ReturnType<Script["refresh"]>,
  ): ReturnType<typeof scenario.onHost> =>
    scenario.onHost(
      scenario.ours("first"),
      Struct.assign(PluginRig.quiet, { refresh: () => failure }),
    ),
  exhaustedHost = didFail(
    Effect.fail(
      ClaudeAuthRefreshExhaustedError.make({ message: EXHAUSTED_MESSAGE }),
    ),
  ),
  terminalHost = didFail(
    Effect.fail(
      ClaudeAuthTerminalError.make({ message: ClaudeAuthTerminalError.text }),
    ),
  )

describe("401 recovery that ends in a credential error", () => {
  // One block per failure, so each test sets up a plugin of its own.
  for (const [kind, message, host] of [
    ["terminal", ClaudeAuthTerminalError.text, terminalHost],
    ["exhausted", EXHAUSTED_MESSAGE, exhaustedHost],
  ] as const) {
    test.layer(host)((it: Tests) => {
      it.effect(
        `reports a ${kind} credential failure in the 401 the user sees`,
        () =>
          Effect.gen(function* run() {
            expect.hasAssertions()
            yield* fakeHost.setUp

            const answered = yield* scenario.respond(
                yield* scenario.send(scenario.messages()),
                scenario.unauthorized(),
              ),
              body = yield* transformsSupport
                .bodyText(answered)
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)))

            expect(answered.status).toBe(UNAUTHORIZED)
            expect(body).toStrictEqual({
              error: { message, type: "authentication_error" },
              type: "error",
            })
          }),
      )
    })
  }
})
