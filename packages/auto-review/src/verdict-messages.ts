import type assessment from "./assessment.ts"
import codexMessages from "./vendor/codex/messages.ts"

type Assessment = typeof assessment.Assessment.Type

/* The message a denial returns to the agent. */
const denialMessage = (assessed: Assessment): string =>
    [
      `Auto-review denied this action (risk: ${assessed.riskLevel}, user authorization: ${assessed.userAuthorization}): ${assessed.rationale}`,
      codexMessages.REJECTION_INSTRUCTIONS,
    ].join("\n\n"),
  /* The message the user sees once denials in a turn reach their limit. */
  escalationMessage = (assessed: Assessment, total: number): string =>
    `Auto-review has denied ${total} actions this turn, so it is asking you instead. Its reason for this one (risk: ${assessed.riskLevel}): ${assessed.rationale}`

/** The messages a reviewer's denial carries to the agent or the user. */
export default Object.freeze({ denialMessage, escalationMessage })
