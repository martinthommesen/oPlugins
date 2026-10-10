import { Effect, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import ClaudeAuthRefreshExhaustedError from "./claude-auth-refresh-exhausted-error.ts"
import ClaudeAuthTerminalError from "./claude-auth-terminal-error.ts"
import PluginRig from "./plugin-rig.test-support.ts"
import fakeHost from "./fake-host.test-support.ts"
import scenario from "./plugin-scenario.test-support.ts"
import transformsSupport from "./request-transforms.test-support.ts"

type Script = typeof PluginRig.quiet

const EXHAUSTED_MESSAGE =
    "Claude Code token refresh has failed 10 times in a row (network error). Check your network connection; the plugin keeps retrying.",
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
      Object.freeze({
        accounts: PluginRig.quiet.accounts,
        adopt: PluginRig.quiet.adopt,
        fetch: PluginRig.quiet.fetch,
        refresh: () => failure,
      }),
    ),
  exhaustedHost = didFail(
    Effect.fail(
      new ClaudeAuthRefreshExhaustedError({ message: EXHAUSTED_MESSAGE }),
    ),
  ),
  terminalHost = didFail(
    Effect.fail(
      new ClaudeAuthTerminalError({ message: ClaudeAuthTerminalError.text }),
    ),
  )

describe("401 recovery that ends in a credential error", () => {
  it.effect.each([
    ["terminal", ClaudeAuthTerminalError.text, terminalHost],
    ["exhausted", EXHAUSTED_MESSAGE, exhaustedHost],
  ] as const)(
    "reports a %s credential failure in the 401 the user sees",
    ([, message, host]) =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* fakeHost.setUp

        const answered = yield* scenario.respond(
            yield* scenario.send(scenario.messages()),
            new Response("unauthorized", { status: UNAUTHORIZED }),
          ),
          body = yield* transformsSupport
            .bodyText(answered)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)))

        expect(answered.status).toBe(UNAUTHORIZED)
        expect(body).toStrictEqual({
          error: { message, type: "authentication_error" },
          type: "error",
        })
      }).pipe(Effect.provide(host)),
  )
})
