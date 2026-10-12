import { Boolean as Bool, Effect, Predicate } from "effect"
import type {
  SessionContext,
  SessionGenerate,
} from "@opencode/plugin/effect/session"
import type Advisor from "./advisor.ts"
import type Host from "./host.ts"
import TOOL_NAME from "./tool-name.ts"
import availability from "./availability.ts"
import prompt from "./prompt.ts"

/*
 * Gives consultation requests the advisor's instructions in place of the
 * agent's system prompt, and no tools.
 */
const instructConsultations =
    (host: Host["Service"]) =>
    (event: SessionGenerate): Effect.Effect<void> => {
      const instruct = Effect.sync(() => {
        event.system = [{ text: prompt.ADVISOR_INSTRUCTIONS, type: "text" }]
        event.tools = {}
      })

      return instruct.pipe(
        Effect.when(host.isConsultation(event.sessionID)),
        Effect.asVoid,
      )
    },
  /*
   * Offers the advisor only to sessions that may consult it. It removes the
   * tool from every other session, and tells agents that have the tool when
   * to use it.
   */
  presentAdvisor =
    (advisor: Advisor["Service"]) =>
    (event: SessionContext): Effect.Effect<void> => {
      const available = advisor.availability(event.sessionID).pipe(
          Effect.map(availability.Availability.$is("Available")),
          Effect.catchTag(
            "HostError",
            (failure: { readonly operation: string }) =>
              Effect.logWarning("advisor_availability_check_failed").pipe(
                Effect.annotateLogs({
                  operation: failure.operation,
                  sessionID: event.sessionID,
                }),
                Effect.as(false),
              ),
          ),
        ),
        hide = Effect.sync(() => {
          Reflect.deleteProperty(event.tools, TOOL_NAME)
        }),
        // Agents with a fixed tool list may lack the tool even when it is available.
        instruct = Effect.sync(() => {
          if (Predicate.hasProperty(event.tools, TOOL_NAME)) {
            event.system.push({
              text: prompt.CONSULTATION_POLICY,
              type: "text",
            })
          }
        })

      return available.pipe(
        Effect.flatMap((isAvailable) =>
          Bool.match(isAvailable, {
            onFalse: () => hide,
            onTrue: () => instruct,
          }),
        ),
      )
    }

/** The session hooks that offer the advisor and instruct the advisor model. */
export default Object.freeze({ instructConsultations, presentAdvisor })
