import { Agent } from "@opencode/plugin/effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { Types } from "effect"
import prompt from "./prompt.ts"

/** The parts of the host's agent editor that the registration uses. */
interface ConsultationEditor {
  readonly update: (id: string, update: typeof overwrite) => void
}

/** The host's agent transform, as the registration calls it. */
type AgentTransform = (
  callback: (editor: ConsultationEditor) => void,
) => ReturnType<Plugin.Context["agent"]["transform"]>

/*
 * The consultation agent's ID, reserved in oc-advisor's namespace. Setup
 * overwrites an agent the user defines under it.
 */
const ID = Agent.ID.make("oc-advisor-consultation"),
  /* A rule set that denies every action on every resource. */
  denyAll = (): Types.DeepMutable<Agent.Info>["permissions"] => [
    { action: "*", effect: "deny", resource: "*" },
  ],
  /*
   * Makes an agent the consultation agent, whatever it held before: hidden,
   * primary so the subagent tool refuses it, with the advisor's instructions
   * and a final rule that denies every tool. Its model and request overrides
   * go, so the consultation session's model and request apply unchanged.
   */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The host's agent editor hands out a draft to edit in place, so it cannot be readonly.
  overwrite = (draft: Types.DeepMutable<Agent.Info>): void => {
    draft.hidden = true
    draft.mode = "primary"
    draft.permissions = denyAll()
    draft.request = { body: {}, headers: {}, settings: {} }
    draft.system = prompt.ADVISOR_INSTRUCTIONS
    Reflect.deleteProperty(draft, "model")
  },
  /* Registers the consultation agent through the host's agent transform. */
  register = (transform: AgentTransform): ReturnType<AgentTransform> =>
    transform((editor) => {
      editor.update(ID, overwrite)
    })

/** The consultation agent every consultation session runs as. */
export default Object.freeze({ ID, denyAll, register })
