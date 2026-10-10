import type {
  SessionContext,
  SessionGenerate,
} from "@opencode/plugin/effect/session"
import { ADVISOR_INSTRUCTIONS } from "./prompt.ts"
import type { Advisor } from "./advisor.ts"
import { Availability } from "./availability.ts"
import { Effect } from "effect"
import type { Host } from "./host.ts"
import { TOOL_NAME } from "./tool-name.ts"

/**
 * Removes the advisor tool from requests of sessions that may not consult it,
 * so agents are only offered the advisor when calling it can succeed.
 * @param {Advisor["Service"]} advisor The advisor service.
 * @returns {(event: SessionContext) => Effect.Effect<void>} The hook.
 */
const hideUnavailableAdvisor =
  (advisor: Advisor["Service"]) =>
  (event: SessionContext): Effect.Effect<void> => {
    const hidden = advisor.availability(event.sessionID).pipe(
      Effect.map(Availability.$is("Unavailable")),
      Effect.catchTag("HostError", (failure) =>
        Effect.as(
          Effect.logWarning(
            "Hiding the advisor: availability check failed",
            failure,
          ),
          true,
        ),
      ),
    )

    const hide = Effect.sync(() =>
      Reflect.deleteProperty(event.tools, TOOL_NAME),
    )

    return hide.pipe(Effect.when(hidden), Effect.asVoid)
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

export { hideUnavailableAdvisor, instructConsultations }
