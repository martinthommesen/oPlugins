import { Effect } from "effect"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import Verdict from "./verdict.ts"
import redact from "@oc-lib/log-redaction/log-redaction.ts"

type Settled = Parameters<typeof Verdict.$match>[typeof FIRST]

/** What the reviewer decided about one request, as the log records it. */
interface Reviewed {
  readonly action: string
  readonly model: string
  readonly rationale: string
  /** The permission effect applied: `allow`, `deny`, or `ask`. */
  readonly verdict: string
}

const FIRST = 0,
  /* Rewrites the request's effect and message with the verdict. */
  apply = (
    evaluation: PermissionEvaluation,
    verdict: Settled,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      Verdict.$match(verdict, {
        Allow: () => {
          evaluation.effect = "allow"
        },
        Ask: ({ message }) => {
          evaluation.effect = "ask"
          evaluation.message = message
        },
        Deny: ({ message }) => {
          evaluation.effect = "deny"
          evaluation.message = message
        },
        Escalate: ({ message }) => {
          evaluation.effect = "ask"
          evaluation.message = message
        },
      })
    }),
  /*
   * Logs a reviewer's decision. The info record carries metadata only; the
   * rationale is model output, so it goes to a debug record, redacted.
   */
  logReviewed = (reviewed: Reviewed): Effect.Effect<void> => {
    const rationale = Effect.logDebug("auto_review_rationale").pipe(
      Effect.annotateLogs(
        redact({ action: reviewed.action, rationale: reviewed.rationale }),
      ),
    )

    return Effect.logInfo("auto_review_verdict").pipe(
      Effect.annotateLogs({
        action: reviewed.action,
        model: reviewed.model,
        verdict: reviewed.verdict,
      }),
      Effect.andThen(rationale),
    )
  },
  /* Logs the verdict on the request's action. */
  record = (
    evaluation: PermissionEvaluation,
    verdict: Settled,
  ): Effect.Effect<void> => {
    const { action } = evaluation

    return Verdict.$match(verdict, {
      Allow: ({ model, rationale }) =>
        logReviewed({ action, model, rationale, verdict: "allow" }),
      Ask: () =>
        Effect.logInfo("auto_review_verdict").pipe(
          Effect.annotateLogs({ action, verdict: "ask" }),
        ),
      Deny: ({ model, rationale }) =>
        logReviewed({ action, model, rationale, verdict: "deny" }),
      Escalate: ({ model, rationale }) =>
        logReviewed({ action, model, rationale, verdict: "ask" }),
    })
  }

/** Applying a verdict to the permission request, and recording it in the log. */
export default Object.freeze({ apply, record })
