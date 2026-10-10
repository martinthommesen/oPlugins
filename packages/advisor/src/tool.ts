import type { Advice, Advisor } from "./advisor.ts"
import { Effect, Match, Option, Schema } from "effect"
import type { ConsultationError } from "./errors/consultation-error.ts"
import { TOOL_DESCRIPTION } from "./prompt.ts"
import { TOOL_NAME } from "./tool-name.ts"
import type { Tool } from "@opencode/schema/tool"

const ToolInput = Schema.Struct({
  question: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "What you want the advisor's opinion on, such as the plan you are about to follow or the problem you are stuck on. Optional.",
    }),
  ),
})

/**
 * Explains to the consulting agent why it got no advice.
 * @param {ConsultationError} error Why the consultation failed.
 * @returns {Tool.Result} A result the agent can act on.
 */
const failureResult = (error: ConsultationError): Tool.Result => {
  const reason = Match.valueTags(error, {
    AdvisorUnavailable: ({ reason: why }) =>
      `The advisor is unavailable: ${why}.`,
    ConsultationTimedOut: ({ model, seconds }) =>
      `The advisor (${model}) did not answer within ${seconds} seconds.`,
    HostError: ({ operation }) => `The advisor request failed (${operation}).`,
    InvalidModel: ({ model, reason: why }) =>
      `The configured advisor model ${model} is invalid: ${why}.`,
  })

  return { content: `${reason} Continue without the advisor's input.` }
}

const adviceResult = (advice: Advice): Tool.Result => ({
  content: advice.text,
  metadata: { model: advice.model },
})

/**
 * Defines the tool agents call to consult the advisor.
 * @param {Advisor["Service"]} advisor The advisor service.
 * @returns {Tool.Info<typeof ToolInput, undefined>} The tool definition.
 */
const advisorTool = (
  advisor: Advisor["Service"],
): Tool.Info<typeof ToolInput, undefined> => ({
  description: TOOL_DESCRIPTION,
  execute: (input, context) =>
    advisor
      .consult(context.sessionID, Option.fromUndefinedOr(input.question))
      .pipe(
        Effect.tapError((failure) =>
          Effect.logWarning("Advisor consultation failed", failure),
        ),
        Effect.match({ onFailure: failureResult, onSuccess: adviceResult }),
      ),
  input: ToolInput,
  name: TOOL_NAME,
  options: { codemode: false },
})

export { advisorTool }
