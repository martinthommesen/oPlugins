import { Effect, Fiber, Schema } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"
import host from "./plugin-host.test-support.ts"

type Script = Parameters<typeof host.setUp>[typeof FIRST]

/** The `it` of a `test.layer` block: `it.effect`, given the captured logs. */
interface Tests {
  readonly effect: Vitest.Test<CapturedLogs | Scope.Scope>
}

const FIRST = 0,
  encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown)),
  /*
   * Reviews a prompt with setup's registered permission hook under
   * `script`. Returns the prompt's message, the `auto_review_failed`
   * warnings, and whether any record or the message quotes the secret.
   */
  failedReview = Effect.fn("test.failedReview")(function* failedReview(
    script: Script,
  ) {
    const evaluation = host.askToPush(),
      logs = yield* CapturedLogs,
      plugin = yield* host.setUp(script),
      running = yield* plugin.review(evaluation).pipe(Effect.forkChild)

    // The client retries transient failures with backoff on the test clock.
    yield* TestClock.adjust("1 second")
    yield* Fiber.join(running)

    return {
      effect: evaluation.effect,
      leaked: (yield* encodeJson([
        yield* logs.records,
        evaluation.message,
      ])).includes(host.SECRET),
      message: evaluation.message,
      warnings: (yield* logs.named("auto_review_failed")).map(
        (record) => record.annotations,
      ),
    }
  }, Effect.scoped)

describe("a failed review request's record", () => {
  test.layer(CapturedLogs.layer)((it: Tests) => {
    it.effect("names a rate limit, its status, and when to retry", () =>
      Effect.gen(function* rateLimited() {
        expect.hasAssertions()

        const review = yield* failedReview({
          respond: host.rateLimited,
          signedIn: true,
        })

        expect(review.effect).toBe("ask")
        expect(review.warnings).toStrictEqual([
          {
            category: "rate_limited",
            error: "RequestFailed",
            model: "codex-auto-review",
            operation: "status",
            status: 429,
          },
        ])
        expect(review.message).toBe(
          "Auto-review could not decide: The reviewer backend is limiting requests (HTTP 429). Wait a few minutes before you rely on auto-review again. Approve or reject this request yourself.",
        )
        expect(review.leaked).toBe(false)
      }),
    )
  })
})

describe("a review request's record when the network fails", () => {
  test.layer(CapturedLogs.layer)((it: Tests) => {
    it.effect("names a network failure", () =>
      Effect.gen(function* unreachable() {
        expect.hasAssertions()

        const review = yield* failedReview({
          respond: host.unreachable,
          signedIn: true,
        })

        expect(review.effect).toBe("ask")
        expect(review.warnings).toStrictEqual([
          {
            category: "network",
            error: "RequestFailed",
            model: "codex-auto-review",
            operation: "execute",
          },
        ])
        expect(review.message).toBe(
          "Auto-review could not decide: The reviewer backend could not be reached. Check the network connection. Approve or reject this request yourself.",
        )
        expect(review.leaked).toBe(false)
      }),
    )
  })
})

describe("a failed host call's record", () => {
  test.layer(CapturedLogs.layer)((it: Tests) => {
    it.effect("names the category of the host's failure", () =>
      Effect.gen(function* missingSession() {
        expect.hasAssertions()

        const review = yield* failedReview({
          respond: host.assessing("allow"),
          session: Effect.fail(host.SESSION_NOT_FOUND),
          signedIn: true,
        })

        expect(review.effect).toBe("ask")
        expect(review.warnings).toStrictEqual([
          {
            category: "not_found",
            error: "HostError",
            operation: "session.get",
          },
        ])
        expect(review.leaked).toBe(false)
      }),
    )
  })

  test.layer(CapturedLogs.layer)((it: Tests) => {
    it.effect("falls back to unknown for an unstructured failure", () =>
      Effect.gen(function* unstructured() {
        expect.hasAssertions()

        const review = yield* failedReview({
          respond: host.assessing("allow"),
          session: Effect.fail(host.SECRET),
          signedIn: true,
        })

        expect(review.effect).toBe("ask")
        expect(review.warnings).toStrictEqual([
          { category: "unknown", error: "HostError", operation: "session.get" },
        ])
        expect(review.message).toBe(
          "Auto-review could not decide: OpenCode failed to answer the plugin's session.get call. Approve or reject this request yourself.",
        )
        expect(review.leaked).toBe(false)
      }),
    )
  })
})
