import { Data, Effect, Option } from "effect"
import AdvisorUnavailable from "./advisor-unavailable-error.ts"
import type HostError from "./host-error.ts"
import type PreferenceStore from "./preference-store.ts"

type Preferences = Effect.Success<PreferenceStore["Service"]["current"]>

/** Whether a session may consult the advisor, and why not. */
type Decision = Data.TaggedEnum<{
  Available: { readonly model: string }
  Unavailable: { readonly reason: string }
}>

const Availability = Data.taggedEnum<Decision>(),
  /*
   * Decides whether a session may consult the advisor. `isSubagent` tells
   * whether the session is a subagent's; it only runs when subagents are
   * blocked.
   */
  decideAvailability = (
    preferences: Preferences,
    isSubagent: Effect.Effect<boolean, HostError>,
  ): Effect.Effect<Decision, HostError> =>
    Option.match(preferences.model, {
      onNone: () =>
        Effect.succeed(
          Availability.Unavailable({
            reason: "no advisor model is configured",
          }),
        ),
      onSome: (model) => {
        if (!preferences.enabled) {
          return Effect.succeed(
            Availability.Unavailable({ reason: "the advisor is turned off" }),
          )
        }

        if (preferences.subagents) {
          return Effect.succeed(Availability.Available({ model }))
        }

        return isSubagent.pipe(
          Effect.map((subagent) => {
            if (subagent) {
              return Availability.Unavailable({
                reason: "the advisor is turned off for subagents",
              })
            }

            return Availability.Available({ model })
          }),
        )
      },
    }),
  /*
   * Reads the advisor model out of an availability, or fails with the reason
   * the session may not consult it.
   */
  requireModel = (
    availability: Decision,
  ): Effect.Effect<string, AdvisorUnavailable> =>
    Availability.$match(availability, {
      Available: ({ model }) => Effect.succeed(model),
      Unavailable: ({ reason }) =>
        Effect.fail(new AdvisorUnavailable({ reason })),
    })

/** Deciding whether a session may consult the advisor. */
export default Object.freeze({
  Availability,
  decideAvailability,
  requireModel,
})
