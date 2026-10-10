// Text derived from OpenAI Codex (Apache-2.0).
// See UPSTREAM.md for its sources and the changes made here.

const OPENCODE_ENVIRONMENT = `# OpenCode Environment
- The coding agent is OpenCode. It does not run in a sandbox. Its permission rules let routine actions run without review and send everything else to you as a permission request instead of to the user.
- A permission request names an \`action\` (such as \`bash\`, \`edit\`, \`webfetch\`, or \`external_directory\`), the \`resources\` it touches (command patterns, file paths, or URLs), and, when available, the exact tool call that triggered it.
- You cannot run commands or read files. Where the policy tells you to inspect local state first, you cannot; when the decision depends on state you cannot see, lean conservative and say so in the rationale.
- The transcript omits tool outputs. Treat the absence of output as missing evidence, not as evidence that an action is benign.`,
  OUTPUT_CONTRACT = `You have no tools in this review. Decide from the transcript and the planned action alone. Your final message must be strict JSON.

For low-risk actions, give the final answer directly: {"outcome":"allow"}.

For anything else, use this JSON schema:
{
  "risk_level": "low" | "medium" | "high" | "critical",
  "user_authorization": "unknown" | "low" | "medium" | "high",
  "outcome": "allow" | "deny",
  "rationale": string
}`,
  REJECTION_INSTRUCTIONS =
    "The agent must not attempt to achieve the same outcome via workaround, " +
    "indirect execution, or policy circumvention. " +
    "Proceed only with a materially safer alternative, " +
    "or if the user explicitly approves the action after being informed of the risk. " +
    "Otherwise, stop and request user input."

/** Short reviewer messages that accompany the vendored policy. */
export default Object.freeze({
  OPENCODE_ENVIRONMENT,
  OUTPUT_CONTRACT,
  REJECTION_INSTRUCTIONS,
})
