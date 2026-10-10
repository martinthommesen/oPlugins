import { Availability, decideAvailability } from "./availability.ts"
import { Effect, Option } from "effect"
import { assert, describe, it } from "@effect/vitest"
import type { Preferences } from "./preferences.ts"

const ready: Preferences = {
  enabled: true,
  model: Option.some("anthropic/claude-opus-5-5"),
  subagents: true,
}

const neverAsked = Effect.die("the session was looked up")

describe(decideAvailability, () => {
  it.effect("does not look up the session when subagents are allowed", () =>
    Effect.gen(function* skipsLookup() {
      const availability = yield* decideAvailability(ready, neverAsked)

      assert.deepStrictEqual(
        availability,
        Availability.Available({ model: "anthropic/claude-opus-5-5" }),
      )
    }),
  )

  it.effect("names the missing model before the off switch", () =>
    Effect.gen(function* namesMissingModel() {
      const availability = yield* decideAvailability(
        { enabled: false, model: Option.none(), subagents: true },
        neverAsked,
      )

      assert.deepStrictEqual(
        availability,
        Availability.Unavailable({ reason: "no advisor model is configured" }),
      )
    }),
  )

  it.effect("blocks only subagent sessions when subagents are off", () =>
    Effect.gen(function* blocksSubagents() {
      const blocked = { enabled: true, model: ready.model, subagents: false }

      const primary = yield* decideAvailability(blocked, Effect.succeed(false))

      const subagent = yield* decideAvailability(blocked, Effect.succeed(true))

      assert.isTrue(Availability.$is("Available")(primary))
      assert.isTrue(Availability.$is("Unavailable")(subagent))
    }),
  )
})
