import { Effect, Match, Option, Schema } from "effect"
import type Advisor from "./advisor.ts"
import type AdvisorUnavailable from "./advisor-unavailable-error.ts"
import type ConsultationTimedOut from "./consultation-timed-out-error.ts"
import type HostError from "./host-error.ts"
import type InvalidModel from "./invalid-model-error.ts"
import TOOL_NAME from "./tool-name.ts"
import type { Tool } from "@opencode/schema/tool"
import prompt from "./prompt.ts"

type Advice = Effect.Success<ReturnType<Advisor["Service"]["consult"]>>

/** The fields of a consultation failure that the log may carry. */
type ConsultationFailure =
  | Readonly<Pick<AdvisorUnavailable, "_tag">>
  | Readonly<Pick<ConsultationTimedOut, "_tag" | "model" | "seconds">>
  | Readonly<Pick<HostError, "_tag" | "category" | "operation">>
  | Readonly<Pick<InvalidModel, "_tag" | "model">>

const ToolInput = Schema.Struct({
    /** The agent's question for the advisor, if it has one. */
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
  /*
   * Logs why a consultation gave no advice, as metadata only: a host error
   * may quote the conversation.
   */
  adviceFailureLog = (failure: ConsultationFailure): Effect.Effect<void> =>
    Effect.logWarning("advisor_consultation_failed").pipe(
      Effect.annotateLogs(
        Match.valueTags(failure, {
          AdvisorUnavailable: () => ({ error: "AdvisorUnavailable" }),
          ConsultationTimedOut: ({ model, seconds }) => ({
            error: "ConsultationTimedOut",
            model,
            seconds,
          }),
          HostError: ({ category, operation }) => ({
            category,
            error: "HostError",
            operation,
          }),
          InvalidModel: ({ model }) => ({ error: "InvalidModel", model }),
        }),
      ),
    ),
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
          Effect.tapError((failure: ConsultationFailure) =>
            adviceFailureLog(failure),
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
