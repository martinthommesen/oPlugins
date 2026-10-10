import { Effect, Option } from "effect"
import { assert, describe, it } from "@effect/vitest"
import type PreferenceStore from "./preference-store.ts"
import availability from "./availability.ts"

type Preferences = Effect.Success<PreferenceStore["Service"]["current"]>

const { Availability } = availability,
  neverAsked = Effect.die("the session was looked up"),
  ready: Preferences = {
    enabled: true,
    model: Option.some("anthropic/claude-opus-5-5"),
    subagents: true,
  }

describe("decideAvailability", () => {
  it.effect("does not look up the session when subagents are allowed", () =>
    Effect.gen(function* skipsLookup() {
      const decision = yield* availability.decideAvailability(ready, neverAsked)

      assert.deepStrictEqual(
        decision,
        Availability.Available({
          model: "anthropic/claude-opus-5-5",
        }),
      )
    }),
  )

  it.effect("names the missing model before the off switch", () =>
    Effect.gen(function* namesMissingModel() {
      const decision = yield* availability.decideAvailability(
        { enabled: false, model: Option.none(), subagents: true },
        neverAsked,
      )

      assert.deepStrictEqual(
        decision,
        Availability.Unavailable({
          reason: "no advisor model is configured",
        }),
      )
    }),
  )

  it.effect("blocks only subagent sessions when subagents are off", () =>
    Effect.gen(function* blocksSubagents() {
      const blocked = { enabled: true, model: ready.model, subagents: false },
        primary = yield* availability.decideAvailability(
          blocked,
          Effect.succeed(false),
        ),
        subagent = yield* availability.decideAvailability(
          blocked,
          Effect.succeed(true),
        )

      assert.isTrue(Availability.$is("Available")(primary))
      assert.isTrue(Availability.$is("Unavailable")(subagent))
    }),
  )
})
