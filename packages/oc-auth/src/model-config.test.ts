import { Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import modelConfig from "./model-config.ts"

const DENIED_MODELS = [
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-0",
    "claude-opus-4-20250514",
    "claude-opus-4-1",
    "claude-opus-4-1-20250805",
    "claude-sonnet-4-0",
    "claude-sonnet-4-20250514",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "CLAUDE-SONNET-4-5[1m]",
  ],
  EFFORT = "effort-2025-11-24",
  EFFORT_MODELS = [
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-mythos-5-1",
    "claude-haiku-5-5",
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-sonnet-5",
    "claude-sonnet-5-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6-20260217",
    "claude-sonnet-4-50",
    "claude-opus-4-10",
    "claude-future-6",
  ],
  ONE_ASSERTION = 1,
  /** The base set, written out so a change to the list has to change a test. */
  STANDARD_BETAS = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
    "thinking-token-count-2026-05-13",
    EFFORT,
    "extended-cache-ttl-2025-04-11",
  ],
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2,
  /* The betas for `model` with no override and no inbound header. */
  betasOf = (model: string): readonly string[] =>
    modelConfig.modelBetas(model, Option.none(), ""),
  /* The models in `models` whose betas include effort, given `betas`. */
  sendingEffort = (
    models: readonly string[],
    betas: (model: string) => readonly string[],
  ): readonly string[] =>
    models.filter((model) => betas(model).includes(EFFORT))

describe("model betas by default", () => {
  it.effect("returns the required Claude Code flags", () =>
    Effect.sync(() => {
      expect.assertions(ONE_ASSERTION)
      expect(betasOf("claude-fable-5-1")).toStrictEqual(STANDARD_BETAS)
    }),
  )

  it.effect("sends effort for the models the CLI enables it on", () =>
    Effect.sync(() => {
      expect.assertions(ONE_ASSERTION)
      expect(sendingEffort(EFFORT_MODELS, betasOf)).toStrictEqual(EFFORT_MODELS)
    }),
  )

  it.effect("strips effort for the ids the CLI's predicate denies", () =>
    Effect.sync(() => {
      expect.assertions(THREE_ASSERTIONS)
      expect(sendingEffort(DENIED_MODELS, betasOf)).toStrictEqual([])
      expect(
        sendingEffort(DENIED_MODELS, (model) =>
          modelConfig.modelBetas(
            model,
            Option.some(`oauth-2025-04-20,${EFFORT}`),
            "",
          ),
        ),
      ).toStrictEqual([])
      expect(
        sendingEffort(DENIED_MODELS, (model) =>
          modelConfig.modelBetas(model, Option.none(), EFFORT),
        ),
      ).toStrictEqual([])
    }),
  )
})

describe("model betas with an inbound header", () => {
  it.effect("merges inbound flags after the base set", () =>
    Effect.sync(() => {
      expect.assertions(ONE_ASSERTION)
      expect(
        modelConfig.modelBetas(
          "claude-opus-5",
          Option.none(),
          " custom-beta,, ",
        ),
      ).toStrictEqual([...STANDARD_BETAS, "custom-beta"])
    }),
  )

  it.effect("cannot be changed by an importer", () =>
    Effect.sync(() => {
      expect.assertions(TWO_ASSERTIONS)
      expect(() =>
        Array.prototype.push.call(modelConfig.baseBetas, "injected"),
      ).toThrow(TypeError)
      expect(betasOf("claude-opus-5")).not.toContain("injected")
    }),
  )
})

describe("model betas with an empty override", () => {
  it.effect("falls back to the base set when the override is empty", () =>
    Effect.sync(() => {
      expect.assertions(TWO_ASSERTIONS)
      expect(
        modelConfig.modelBetas("claude-opus-5", Option.some(""), ""),
      ).toStrictEqual(STANDARD_BETAS)
      expect(
        modelConfig.modelBetas("claude-opus-5", Option.some("  "), ""),
      ).toStrictEqual(STANDARD_BETAS)
    }),
  )
})

describe("model betas with a replacing override", () => {
  it.effect("uses a deduplicated override", () =>
    Effect.sync(() => {
      expect.assertions(ONE_ASSERTION)
      expect(
        modelConfig.modelBetas(
          "claude-sonnet-4-5",
          Option.some("custom-beta, custom-beta, oauth-2025-04-20"),
          "",
        ),
      ).toStrictEqual([
        "claude-code-20250219",
        "oauth-2025-04-20",
        "custom-beta",
      ])
    }),
  )

  it.effect(
    "keeps the betas subscription auth needs when an override omits them",
    () =>
      Effect.sync(() => {
        expect.assertions(THREE_ASSERTIONS)

        const betas = modelConfig.modelBetas(
          "claude-opus-5",
          Option.some("context-1m-2025-08-07"),
          "",
        )

        expect(betas).toContain("oauth-2025-04-20")
        expect(betas).toContain("claude-code-20250219")
        expect(betas).toContain("context-1m-2025-08-07")
      }),
  )
})

describe("model betas with a malformed override", () => {
  it.effect("falls back to the base set for a separator-only override", () =>
    Effect.sync(() => {
      expect.assertions(TWO_ASSERTIONS)
      expect(
        modelConfig.modelBetas("claude-opus-5", Option.some(","), ""),
      ).toStrictEqual(STANDARD_BETAS)
      expect(
        modelConfig.modelBetas("claude-opus-5", Option.some(" , , "), ""),
      ).toStrictEqual(STANDARD_BETAS)
    }),
  )
})
