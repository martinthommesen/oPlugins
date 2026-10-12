import { Boolean as Bool, Effect, Predicate } from "effect"
import type Advisor from "./advisor.ts"
import type { SessionContext } from "@opencode/plugin/effect/session"
import TOOL_NAME from "./tool-name.ts"
import availability from "./availability.ts"
import prompt from "./prompt.ts"

/*
 * Offers the advisor only to sessions that may consult it. It removes the
 * tool from every other session, and tells agents that have the tool when
 * to use it.
 */
const presentAdvisor =
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

/** The session hook that offers the advisor. */
export default Object.freeze({ presentAdvisor })
