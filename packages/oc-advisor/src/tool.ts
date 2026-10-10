import { Effect, Option, Schema } from "effect"
import type Advisor from "./advisor.ts"
import TOOL_NAME from "./tool-name.ts"
import type { Tool } from "@opencode/schema/tool"
import prompt from "./prompt.ts"

type Advice = Effect.Success<ReturnType<Advisor["Service"]["consult"]>>

const ToolInput = Schema.Struct({
    question: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "What you want the advisor's opinion on, such as the plan you are about to follow or the problem you are stuck on. Optional.",
      }),
    ),
  }),
  /* Explains to the consulting agent why it got no advice. */
  adviceFailed = (reason: string): Tool.Result => ({
    content: `${reason} Continue without the advisor's input.`,
  }),
  adviceResult = (advice: Advice): Tool.Result => ({
    content: advice.text,
    metadata: { model: advice.model },
  }),
  /* Defines the tool agents call to consult the advisor. */
  advisorTool = (
    advisor: Advisor["Service"],
  ): Tool.Info<typeof ToolInput, undefined> => ({
    description: prompt.TOOL_DESCRIPTION,
    execute: (input, context) =>
      advisor
        .consult(context.sessionID, Option.fromUndefinedOr(input.question))
        .pipe(
          Effect.tapError((failure: { readonly message: string }) =>
            Effect.logWarning("Advisor consultation failed", failure),
          ),
          Effect.map((advice) => adviceResult(advice)),
          Effect.catchTags({
            AdvisorUnavailable: (failure: { readonly reason: string }) =>
              Effect.succeed(
                adviceFailed(`The advisor is unavailable: ${failure.reason}.`),
              ),
            ConsultationTimedOut: (failure: {
              readonly model: string
              readonly seconds: number
            }) =>
              Effect.succeed(
                adviceFailed(
                  `The advisor (${failure.model}) did not answer within ${failure.seconds} seconds.`,
                ),
              ),
            HostError: (failure: { readonly operation: string }) =>
              Effect.succeed(
                adviceFailed(
                  `The advisor request failed (${failure.operation}).`,
                ),
              ),
            InvalidModel: (failure: {
              readonly model: string
              readonly reason: string
            }) =>
              Effect.succeed(
                adviceFailed(
                  `The configured advisor model ${failure.model} is invalid: ${failure.reason}.`,
                ),
              ),
          }),
        ),
    input: ToolInput,
    name: TOOL_NAME,
    options: { codemode: false },
  })

/** The tool agents call to consult the advisor. */
export default Object.freeze({ advisorTool })
