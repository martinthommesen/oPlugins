import { Data, Effect, Option } from "effect"
import { AdvisorUnavailable } from "./errors/advisor-unavailable.ts"
import type { HostError } from "./errors/host-error.ts"
import type { Preferences } from "./preferences.ts"

/** Whether a session may consult the advisor, and why not. */
type Availability = Data.TaggedEnum<{
  Available: { readonly model: string }
  Unavailable: { readonly reason: string }
}>

const Availability = Data.taggedEnum<Availability>()

/**
 * Decides whether a session may consult the advisor.
 * @param {Preferences} preferences The configuration in effect.
 * @param {Effect.Effect<boolean, HostError>} isSubagent Whether the session
 * is a subagent's; only run when subagents are blocked.
 * @returns {Effect.Effect<Availability, HostError>} The decision.
 */
const decideAvailability = (
  preferences: Preferences,
  isSubagent: Effect.Effect<boolean, HostError>,
): Effect.Effect<Availability, HostError> =>
  Option.match(preferences.model, {
    onNone: () =>
      Effect.succeed(
        Availability.Unavailable({ reason: "no advisor model is configured" }),
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
  })

/**
 * Reads the advisor model out of an availability, or fails with the reason
 * the session may not consult it.
 * @param {Availability} availability The session's availability.
 * @returns {Effect.Effect<string, AdvisorUnavailable>} The advisor model.
 */
const requireModel = (
  availability: Availability,
): Effect.Effect<string, AdvisorUnavailable> =>
  Availability.$match(availability, {
    Available: ({ model }) => Effect.succeed(model),
    Unavailable: ({ reason }) =>
      Effect.fail(new AdvisorUnavailable({ reason })),
  })

export { Availability, decideAvailability, requireModel }
