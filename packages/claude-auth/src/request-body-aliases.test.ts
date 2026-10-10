import { Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import type { Cause } from "effect"
import RequestTransforms from "./request-transforms.ts"
import requestBodyAliases from "./request-body-aliases.ts"
import support from "./request-transforms.test-support.ts"
import toolAliases from "./tool-aliases.ts"

/** An aliased body as text, with the aliases applied. */
interface AliasedText {
  readonly originalByAlias: Readonly<Record<string, string>>
  readonly text: string
}

const FIVE_ASSERTIONS = 5,
  ONE_ASSERTION = 1,
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2,
  /* A body with offered, chosen and called tools under these names. */
  historyPayload = ([offered, custom, called]: readonly [
    string,
    string,
    string,
  ]): string =>
    JSON.stringify({
      messages: [
        {
          content: [{ id: "one", input: {}, name: called, type: "tool_use" }],
          role: "assistant",
        },
        {
          content: [
            { content: "hit", tool_use_id: "one", type: "tool_result" },
          ],
          role: "user",
        },
      ],
      tool_choice: { name: offered, type: "tool" },
      tools: [
        { input_schema: {}, name: offered },
        { input_schema: {}, name: custom, type: "custom" },
        { name: "web_search", type: "web_search_20250305" },
      ],
    }),
  /* A body that offers `toolName` deferred and references `referenced`. */
  searchPayload = (toolName: string, referenced: string): string =>
    JSON.stringify({
      messages: [
        {
          content: [
            {
              content: [
                { tool_name: referenced, type: "tool_reference" },
                { tool_name: "mcp_Real", type: "tool_reference" },
              ],
              tool_use_id: "search",
              type: "tool_search_tool_result",
            },
          ],
          role: "user",
        },
      ],
      model: "claude-haiku-5-5",
      output_config: { effort: "high" },
      thinking: { type: "adaptive" },
      tools: [
        {
          defer_loading: true,
          input_schema: { type: "object" },
          name: toolName,
        },
        {
          name: "tool_search_tool_regex",
          type: "tool_search_tool_regex_20251119",
        },
      ],
    }),
  textDecoder = new TextDecoder(),
  textEncoder = new TextEncoder(),
  /* A body offering tools under `names`. */
  toolList = (names: readonly string[]): string =>
    JSON.stringify({ tools: names.map((name) => ({ name })) }),
  /* The model the body `payload` names. */
  wireModel = (payload: string): Option.Option<string> =>
    requestBodyAliases
      .alias(textEncoder.encode(payload))
      .pipe(Option.flatMap((aliased) => aliased.model)),
  /* The body after aliasing `payload`, as text, and the aliases applied. */
  wiredText = (
    payload: string,
  ): Effect.Effect<AliasedText, Cause.NoSuchElementError> =>
    Effect.fromOption(
      requestBodyAliases.alias(textEncoder.encode(payload)),
    ).pipe(
      Effect.map((aliased) => ({
        originalByAlias: aliased.originalByAlias,
        text: textDecoder.decode(aliased.body),
      })),
    )

describe("request body tool references", () => {
  it.effect(
    "aliases deferred tool references while preserving modern model settings",
    () =>
      Effect.gen(function* run() {
        expect.assertions(THREE_ASSERTIONS)

        const transformed = yield* wiredText(searchPayload("read", "read"))

        expect(transformed.text).toBe(searchPayload("mcp_Read", "mcp_Read"))
        expect(transformed.originalByAlias).toStrictEqual({ mcp_Read: "read" })
        expect(
          toolAliases.restore(
            JSON.stringify({ tool_name: "mcp_Read", type: "tool_reference" }),
            transformed.originalByAlias,
          ),
        ).toBe(JSON.stringify({ tool_name: "read", type: "tool_reference" }))
      }),
  )
})

describe("request body tool names", () => {
  it.effect("aliases client tools, tool choice, and tool_use history", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)
      expect(
        yield* wiredText(historyPayload(["shell", "read", "grep"])),
      ).toStrictEqual({
        originalByAlias: {
          mcp_Grep: "grep",
          mcp_Read: "read",
          mcp_Shell: "shell",
        },
        text: historyPayload(["mcp_Shell", "mcp_Read", "mcp_Grep"]),
      })
    }),
  )

  it.effect("keeps aliases one-to-one when names collide", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const collide = yield* wiredText(toolList(["foo", "Foo"])),
        taken = yield* wiredText(toolList(["mcp_Foo", "foo"]))

      expect(collide).toStrictEqual({
        originalByAlias: { mcp_Foo: "foo" },
        text: toolList(["mcp_Foo", "Foo"]),
      })
      expect(taken).toStrictEqual({
        originalByAlias: {},
        text: toolList(["mcp_Foo", "foo"]),
      })
      expect(
        toolAliases.restore('{"name":"mcp_Foo"}', taken.originalByAlias),
      ).toBe('{"name":"mcp_Foo"}')
    }),
  )
})

describe("request body model", () => {
  it.effect("reads the model the body names before it rewrites anything", () =>
    Effect.sync(() => {
      expect.assertions(THREE_ASSERTIONS)
      expect(
        wireModel(
          JSON.stringify({
            model: "claude-opus-4-1",
            tools: [{ name: "read" }],
          }),
        ),
      ).toStrictEqual(Option.some("claude-opus-4-1"))
      expect(wireModel(JSON.stringify({ model: 4 }))).toStrictEqual(
        Option.none(),
      )
      expect(wireModel("not json")).toStrictEqual(Option.none())
    }),
  )
})

describe("request body pass-through", () => {
  it.effect("passes through bodies with nothing to alias", () =>
    Effect.gen(function* run() {
      expect.assertions(FIVE_ASSERTIONS)

      const alreadyAliased = yield* wiredText(
          toolList(["mcp_Playwright_click"]),
        ),
        noTools = textEncoder.encode(
          JSON.stringify({ messages: [{ content: "hi", role: "user" }] }),
        ),
        plain = textEncoder.encode("complete-body"),
        result = yield* Effect.fromOption(requestBodyAliases.alias(noTools))

      expect(Option.isNone(requestBodyAliases.alias(plain))).toBe(true)
      expect(result.body).toBe(noTools)
      expect(result.originalByAlias).toStrictEqual({})
      expect(alreadyAliased.originalByAlias).toStrictEqual({})
      expect(alreadyAliased.text).toBe(toolList(["mcp_Playwright_click"]))
    }),
  )

  it.effect("sends a body that is not JSON byte for byte", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const api = yield* RequestTransforms,
        transformed = yield* api.request(
          support.httpEvent(
            new Request("https://api.anthropic.com/v1/messages", {
              body: "complete-body",
              method: "POST",
            }),
            "claude-sonnet-4-5",
          ),
          { access: "access" },
        )

      expect(yield* support.bodyText(transformed.request)).toBe("complete-body")
      expect(transformed.originalByAlias).toStrictEqual({})
    }).pipe(Effect.provide(support.layer())),
  )
})
