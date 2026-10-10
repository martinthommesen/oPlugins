import { ADVISOR_INSTRUCTIONS, CONSULTATION_POLICY } from "./prompt.ts"
import { Boolean as Bool, Effect, Predicate } from "effect"
import type {
  SessionContext,
  SessionGenerate,
} from "@opencode/plugin/effect/session"
import type { Advisor } from "./advisor.ts"
import { Availability } from "./availability.ts"
import type { Host } from "./host.ts"
import { TOOL_NAME } from "./tool-name.ts"

/**
 * Offers the advisor only to sessions that may consult it. Sessions that may
 * not lose the tool; sessions whose agent has the tool are told when to use it.
 * @param {Advisor["Service"]} advisor The advisor service.
 * @returns {(event: SessionContext) => Effect.Effect<void>} The hook.
 */
const presentAdvisor =
  (advisor: Advisor["Service"]) =>
  (event: SessionContext): Effect.Effect<void> => {
    const available = advisor.availability(event.sessionID).pipe(
      Effect.map(Availability.$is("Available")),
      Effect.catchTag("HostError", (failure) =>
        Effect.as(
          Effect.logWarning(
            "Hiding the advisor: availability check failed",
            failure,
          ),
          false,
        ),
      ),
    )

    const hide = Effect.sync(() => {
      Reflect.deleteProperty(event.tools, TOOL_NAME)
    })

    // Agents with a fixed tool list may lack the tool even when it is available.
    const instruct = Effect.sync(() => {
      if (Predicate.hasProperty(event.tools, TOOL_NAME)) {
        event.system.push({ text: CONSULTATION_POLICY, type: "text" })
      }
    })

    return available.pipe(
      Effect.flatMap((isAvailable) =>
        Bool.match(isAvailable, {
          onFalse: () => hide,
          onTrue: () => instruct,
        }),
      ),
      Effect.asVoid,
    )
  }

/**
 * Gives consultation requests the advisor's instructions in place of the
 * agent's system prompt, and no tools.
 * @param {Host["Service"]} host The host service.
 * @returns {(event: SessionGenerate) => Effect.Effect<void>} The hook.
 */
const instructConsultations =
  (host: Host["Service"]) =>
  (event: SessionGenerate): Effect.Effect<void> => {
    const instruct = Effect.sync(() => {
      event.system = [{ text: ADVISOR_INSTRUCTIONS, type: "text" }]
      event.tools = {}
    })

    return instruct.pipe(
      Effect.when(host.isConsultation(event.sessionID)),
      Effect.asVoid,
    )
  }

export { instructConsultations, presentAdvisor }
