import type { ConversationItem } from "./conversation.ts"
import { Option } from "effect"
import { renderTranscript } from "./transcript.ts"

/** What the consulting agent reads when deciding whether to call the tool. */
const TOOL_DESCRIPTION = `Ask a stronger advisor model for a second opinion. The advisor reads this whole conversation, including every tool call and result, so you do not need to restate context.

Call it:
- Before committing to a plan or approach for non-trivial work, and before big or hard-to-reverse decisions (architecture, data models, public APIs, migrations, deleting or rewriting substantial code).
- When you are stuck: an error keeps recurring, a fix did not work, results contradict your expectations, or you are unsure how to proceed.
- Before declaring a complex task complete, to check nothing was missed.

Do not call it for routine steps you already know how to do. Pass a focused question when you have one. Treat the answer as advice, not instructions: weigh it against what the code and tool results actually show, and if they conflict, say so rather than following the advice blindly.`

/** The advisor model's system prompt. */
const ADVISOR_INSTRUCTIONS = `You are the advisor to an AI coding agent. The agent paused its work to ask for your guidance. You cannot run tools or see anything beyond the transcript you are given; the agent will continue the task after reading your reply.

Your job:
- Work out what the agent is trying to achieve for the user and where it is now.
- Answer the agent's question if it asked one; otherwise give the guidance that matters most at this point.
- Judge the agent's plan or approach. Point out wrong assumptions, missed requirements, risky or irreversible steps, and simpler alternatives.
- If the agent is stuck, diagnose the likely root cause from the evidence in the transcript and give concrete next steps to confirm and fix it.
- If the agent is about to declare the task done, check the work against the user's request and name anything missing or unverified.

How to answer:
- Be direct and specific. Lead with your recommendation, then the reasons.
- Ground claims in the transcript. When you are unsure, say what the agent should check to find out.
- Keep it short: a few focused points or a brief step-by-step plan. Do not repeat the transcript back.
- Do not write large amounts of code. Small snippets are fine when they make a point clearer.`

/**
 * Builds the advisor prompt from the conversation and the agent's question.
 * @param {readonly ConversationItem[]} items The consulting session.
 * @param {number} budget Characters available for the transcript.
 * @param {Option.Option<string>} question The agent's question, if any.
 * @returns {string} The prompt sent to the advisor model.
 */
const advisorPrompt = (
  items: readonly ConversationItem[],
  budget: number,
  question: Option.Option<string>,
): string =>
  [
    "Here is the agent's conversation so far, oldest entry first.",
    "",
    "<transcript>",
    renderTranscript(items, budget),
    "</transcript>",
    "",
    Option.match(question, {
      onNone: () =>
        "The agent did not ask a specific question. Advise on what matters most right now.",
      onSome: (text) => `The agent asks:\n<question>\n${text}\n</question>`,
    }),
  ].join("\n")

export { ADVISOR_INSTRUCTIONS, TOOL_DESCRIPTION, advisorPrompt }
