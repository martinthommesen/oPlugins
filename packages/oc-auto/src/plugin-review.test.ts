import { Effect, Fiber } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { TestClock } from "effect/testing"
import host from "./plugin-host.test-support.ts"

type Script = Parameters<typeof host.setUp>[typeof FIRST]

type Evaluation = ReturnType<typeof host.askToPush>

const FIRST = 0,
  /* A prompt as setup's registered permission hook leaves it under `script`. */
  reviewed = (script: Script): Effect.Effect<Evaluation> =>
    Effect.gen(function* review() {
      const evaluation = host.askToPush(),
        plugin = yield* host.setUp(script),
        running = yield* plugin.review(evaluation).pipe(Effect.forkChild)

      // The client retries a failing backend with backoff on the test clock.
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(running)

      return evaluation
    }).pipe(Effect.scoped)

describe("plugin setup's permission hook", () => {
  it.effect("is the evaluate hook", () =>
    Effect.gen(function* registers() {
      expect.hasAssertions()

      const plugin = yield* host.setUp({
        respond: host.assessing("allow"),
        signedIn: true,
      })

      expect(yield* plugin.names).toStrictEqual(["evaluate"])
    }).pipe(Effect.scoped),
  )

  it.effect("allows a prompt the reviewer approves", () =>
    Effect.gen(function* allows() {
      expect.hasAssertions()

      const evaluation = yield* reviewed({
        respond: host.assessing("allow"),
        signedIn: true,
      })

      expect(evaluation.effect).toBe("allow")
    }),
  )

  it.effect("denies a prompt the reviewer rejects", () =>
    Effect.gen(function* denies() {
      expect.hasAssertions()

      const evaluation = yield* reviewed({
        respond: host.assessing("deny"),
        signedIn: true,
      })

      expect(evaluation.effect).toBe("deny")
      expect(evaluation.message).toMatch(/^Auto-review denied this action/u)
    }),
  )
})

describe("plugin setup's permission hook when review fails", () => {
  it.effect("asks the user when the reviewer backend fails", () =>
    Effect.gen(function* backendFails() {
      expect.hasAssertions()

      const evaluation = yield* reviewed({
        respond: host.unavailableBackend,
        signedIn: true,
      })

      expect(evaluation.effect).toBe("ask")
      expect(evaluation.message).toBe(
        "Auto-review could not decide: The reviewer backend had an error (HTTP 503). Try again later. Approve or reject this request yourself.",
      )
    }),
  )

  it.effect("asks the user without a ChatGPT sign-in", () =>
    Effect.gen(function* signedOut() {
      expect.hasAssertions()

      const evaluation = yield* reviewed({
        respond: host.assessing("allow"),
        signedIn: false,
      })

      expect(evaluation.effect).toBe("ask")
      expect(evaluation.message).toBe(
        "Auto-review could not decide: OpenAI is not connected. Run /connect and choose OpenAI. Approve or reject this request yourself.",
      )
    }),
  )
})
