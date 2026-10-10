import { Effect, Option } from "effect"
import ActiveCredential from "./active-credential.ts"
import type { Plugin } from "@opencode/plugin/effect"
import PluginOptions from "./plugin-options.ts"
import claudeCodeCredential from "./claude-code-credential.ts"

/** The parts of the host's model editor that pricing uses. */
interface PricingEditor {
  readonly list: (providerID: string) => readonly { readonly id: string }[]
  readonly update: (
    providerID: string,
    modelID: string,
    update: typeof zeroCost,
  ) => void
}

/** The host's model transform, as pricing calls it. */
type ModelTransform = (
  callback: (editor: PricingEditor) => void,
) => ReturnType<Plugin.Context["model"]["transform"]>

const ZERO_COST = "zero",
  /* Price a model at nothing, as a subscription does. */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The host's model editor hands out a draft to edit in place, so it cannot be readonly.
  zeroCost = (draft: { cost: unknown[] }): void => {
    draft.cost = []
  },
  /*
   * Native pricing stays by default, so OpenCode reports what the traffic
   * would cost at API rates. The `cost: "zero"` option restores the
   * subscription view, for Anthropic models while a Claude Code credential
   * is active.
   */
  zeroCosts = Effect.fn("ModelPricing.register")(function* zeroCosts(
    transform: ModelTransform,
  ) {
    const active = yield* ActiveCredential,
      options = yield* PluginOptions

    if (options.cost !== ZERO_COST) {
      return
    }

    yield* transform((editor) => {
      if (Option.isNone(active.currentUnsafe())) {
        return
      }

      for (const model of editor.list(claudeCodeCredential.INTEGRATION_ID)) {
        editor.update(claudeCodeCredential.INTEGRATION_ID, model.id, zeroCost)
      }
    })
  })

/** Model pricing while a Claude Code subscription is in use. */
export default Object.freeze({ register: zeroCosts })
