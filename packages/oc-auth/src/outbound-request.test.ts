import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import { Effect } from "effect"
import RequestTransforms from "./request-transforms.ts"
import type { Vitest } from "@effect/vitest"
import support from "./request-transforms.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<typeof support.layer>> | Scope.Scope
  >
}

const BODY = JSON.stringify({ messages: [{ content: "hi", role: "user" }] }),
  FOUR_ASSERTIONS = 4,
  MESSAGES_URL = "https://api.anthropic.com/v1/messages",
  MODEL_BODY = JSON.stringify({
    messages: [],
    model: "claude-opus-4-20250514",
  }),
  ONE_ASSERTION = 1,
  THREE_ASSERTIONS = 3,
  TOOLS_BODY = JSON.stringify({ tools: [{ name: "shell" }] }),
  TWO_ASSERTIONS = 2,
  /* A POST to the Messages endpoint carrying `body`. */
  messagesPost = (
    body: string,
    headers: Readonly<Record<string, string>> = {},
  ): Request => new Request(MESSAGES_URL, { body, headers, method: "POST" }),
  /* An event for a POST of `body` with `headers`, for `model`. */
  postEvent = (
    body: string,
    model: string,
    headers: Readonly<Record<string, string>> = {},
  ): ReturnType<typeof support.httpEvent> =>
    support.httpEvent(messagesPost(body, headers), model),
  /* The request a SDK sends: a POST of `BODY` with a custom header. */
  sdkEvent = (): ReturnType<typeof support.httpEvent> =>
    support.httpEvent(
      new Request(`${MESSAGES_URL}?existing=1`, {
        body: BODY,
        headers: { "content-type": "application/json", "x-custom": "keep" },
        method: "POST",
        redirect: "manual",
      }),
      "claude-sonnet-4-5",
    ),
  /* `event`'s request, transformed with an `access` token. */
  transform = (
    event: ReturnType<typeof support.httpEvent>,
  ): Effect.Effect<
    Effect.Success<ReturnType<RequestTransforms["Service"]["request"]>>,
    Effect.Error<ReturnType<RequestTransforms["Service"]["request"]>>,
    RequestTransforms
  > =>
    Effect.gen(function* transformEvent() {
      const api = yield* RequestTransforms

      return yield* api.request(event, { access: "access" })
    })

describe("outbound request replays", () => {
  test.layer(support.layer())((it: Tests) => {
    it.effect(
      "buffers independent bodies for the original request and two retries",
      () =>
        Effect.gen(function* run() {
          expect.assertions(TWO_ASSERTIONS)

          const api = yield* RequestTransforms,
            original = yield* api.request(sdkEvent(), { access: "first" }),
            second = yield* api.replay(original.snapshot, { access: "second" }),
            third = yield* api.replay(original.snapshot, { access: "third" })

          expect(
            yield* Effect.all([
              support.bodyText(original.request),
              support.bodyText(second),
              support.bodyText(third),
            ]),
          ).toStrictEqual([BODY, BODY, BODY])
          expect(second.headers.get("x-client-request-id")).not.toBe(
            third.headers.get("x-client-request-id"),
          )
        }),
    )
  })

  test.layer(support.layer())((it: Tests) => {
    it.effect(
      "replays with the new credential and the request's own options",
      () =>
        Effect.gen(function* run() {
          expect.assertions(FOUR_ASSERTIONS)

          const api = yield* RequestTransforms,
            original = yield* api.request(sdkEvent(), { access: "first" }),
            second = yield* api.replay(original.snapshot, { access: "second" }),
            third = yield* api.replay(original.snapshot, { access: "third" })

          expect(second.headers.get("authorization")).toBe("Bearer second")
          expect(third.headers.get("authorization")).toBe("Bearer third")
          expect(second.headers.get("x-custom")).toBe("keep")
          expect(second.redirect).toBe("manual")
        }),
    )
  })
})

describe("outbound request URL", () => {
  test.layer(support.layer())((it: Tests) => {
    it.effect("adds the beta query parameter and keeps the others", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const api = yield* RequestTransforms,
          transformed = yield* api.request(sdkEvent(), { access: "first" }),
          url = new URL(transformed.request.url)

        expect(url.searchParams.get("beta")).toBe("true")
        expect(url.searchParams.get("existing")).toBe("1")
      }),
    )
  })

  test.layer(support.layer())((it: Tests) => {
    it.effect("does not overwrite an existing beta query parameter", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)

        const transformed = yield* transform(
          support.httpEvent(
            new Request(`${MESSAGES_URL}?beta=false`),
            "claude-sonnet-4-5",
          ),
        )

        expect(new URL(transformed.request.url).searchParams.get("beta")).toBe(
          "false",
        )
      }),
    )
  })
})

test.layer(support.layer())("outbound request model", (it: Tests) => {
  it.effect(
    "selects beta flags using the wire model rather than a configured alias",
    () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const transformed = yield* transform(postEvent(MODEL_BODY, "my-model"))

        expect(transformed.snapshot.modelID).toBe("claude-opus-4-20250514")
        expect(transformed.request.headers.get("anthropic-beta")).not.toContain(
          "effort-2025-11-24",
        )
      }),
  )
})

describe("outbound request tool aliases", () => {
  test.layer(support.layer())((it: Tests) => {
    it.effect("returns the aliases it applied and keeps them for replays", () =>
      Effect.gen(function* run() {
        expect.assertions(THREE_ASSERTIONS)

        const api = yield* RequestTransforms,
          transformed = yield* transform(
            postEvent(TOOLS_BODY, "claude-sonnet-4-5"),
          ),
          wireReplay = yield* api.replay(transformed.snapshot, {
            access: "next",
          })

        expect(transformed.originalByAlias).toStrictEqual({
          mcp_Shell: "shell",
        })
        expect(yield* support.bodyText(transformed.request)).toMatch(
          /"mcp_Shell"/u,
        )
        expect(yield* support.bodyText(wireReplay)).toMatch(/"mcp_Shell"/u)
      }),
    )
  })

  test.layer(support.layer())((it: Tests) => {
    it.effect("sends a fresh content-length for the aliased body", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const transformed = yield* transform(
          postEvent(TOOLS_BODY, "claude-sonnet-4-5", {
            "content-length": String(TOOLS_BODY.length),
          }),
        )

        // No copied header: fetch derives the length from the body it sends.
        expect(transformed.request.headers.has("content-length")).toBe(false)
        expect(yield* support.bodyText(transformed.request)).toBe(
          '{"tools":[{"name":"mcp_Shell"}]}',
        )
      }),
    )
  })
})
