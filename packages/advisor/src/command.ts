import {
  Array as Arr,
  Boolean as Bool,
  Data,
  Effect,
  Match,
  Option,
  String as Str,
  pipe,
} from "effect"
import { findModel, parseModelRef } from "./model-ref.ts"
import { Host } from "./host.ts"
import { PreferenceStore } from "./preferences.ts"
import type { Preferences } from "./preferences.ts"

const COMMAND_NAME = "advisor"

const COMMAND_DESCRIPTION =
  "Configure the advisor model: /advisor [provider/model | on | off | subagents on|off]"

const USAGE = [
  "Usage:",
  "  /advisor                     show the current advisor",
  "  /advisor <provider/model>    set the advisor model and turn it on",
  "  /advisor on | off            turn the advisor on or off",
  "  /advisor subagents on | off  let subagents consult the advisor, or not",
].join("\n")

/** What an `/advisor` invocation asks for. */
type AdvisorCommand =
  | { readonly _tag: "Invalid"; readonly input: string }
  | { readonly _tag: "SetEnabled"; readonly enabled: boolean }
  | { readonly _tag: "SetModel"; readonly model: string }
  | { readonly _tag: "SetSubagents"; readonly allowed: boolean }
  | { readonly _tag: "Status" }

const AdvisorCommand = Data.taggedEnum<AdvisorCommand>()

/**
 * Reads arguments that are not a keyword as a model reference, which must be
 * a single word.
 * @param {readonly string[]} words The arguments, split on whitespace.
 * @param {string} input The arguments as typed.
 * @returns {AdvisorCommand} The requested action.
 */
const modelCommand = (
  words: readonly string[],
  input: string,
): AdvisorCommand =>
  Arr.match(words, {
    onEmpty: () => AdvisorCommand.Status(),
    onNonEmpty: ([model, ...rest]) =>
      Arr.match(rest, {
        onEmpty: () => AdvisorCommand.SetModel({ model }),
        onNonEmpty: () => AdvisorCommand.Invalid({ input }),
      }),
  })

/**
 * Parses the text after `/advisor`.
 * @param {string} input The command's arguments.
 * @returns {AdvisorCommand} The requested action.
 */
const parseCommand = (input: string): AdvisorCommand => {
  const words = pipe(
    Str.split(Str.trim(input), /\s+/u),
    Arr.filter(Str.isNonEmpty),
  )

  const normalized = Str.toLowerCase(pipe(words, Arr.join(" ")))

  return Match.value(normalized).pipe(
    Match.when("", () => AdvisorCommand.Status()),
    Match.when("status", () => AdvisorCommand.Status()),
    Match.when("on", () => AdvisorCommand.SetEnabled({ enabled: true })),
    Match.when("off", () => AdvisorCommand.SetEnabled({ enabled: false })),
    Match.when("subagents on", () =>
      AdvisorCommand.SetSubagents({ allowed: true }),
    ),
    Match.when("subagents off", () =>
      AdvisorCommand.SetSubagents({ allowed: false }),
    ),
    Match.orElse(() => modelCommand(words, input)),
  )
}

/**
 * Describes the advisor configuration for the user.
 * @param {Preferences} preferences The configuration in effect.
 * @returns {string} A short status report.
 */
const describe = (preferences: Preferences): string => {
  const state = Bool.match(preferences.enabled, {
    onFalse: () => "off",
    onTrue: () => "on",
  })

  const advisor = Option.match(preferences.model, {
    onNone: () => "not set",
    onSome: (model) => `${model} (${state})`,
  })

  const subagents = Bool.match(preferences.subagents, {
    onFalse: () => "not allowed",
    onTrue: () => "allowed",
  })

  return [`Advisor: ${advisor}`, `Subagents: ${subagents}`, "", USAGE].join(
    "\n",
  )
}

const setModel = Effect.fn("setModel")(function* setModel(model: string) {
  const host = yield* Host
  const preferences = yield* PreferenceStore

  const ref = yield* parseModelRef(model)

  yield* findModel(ref, model, yield* host.models)

  yield* preferences.update({ enabled: true, model })

  return `Advisor set to ${model}.`
})

const enable = Effect.fn("enable")(function* enable() {
  const preferences = yield* PreferenceStore

  const { model } = yield* preferences.current

  if (Option.isNone(model)) {
    return "No advisor model is set. Choose one with /advisor <provider/model>."
  }

  yield* preferences.update({ enabled: true })

  return `Advisor turned on (${model.value}).`
})

const disable = Effect.fn("disable")(function* disable() {
  const preferences = yield* PreferenceStore

  yield* preferences.update({ enabled: false })

  return "Advisor turned off."
})

const setSubagents = Effect.fn("setSubagents")(function* setSubagents(
  allowed: boolean,
) {
  const preferences = yield* PreferenceStore

  yield* preferences.update({ subagents: allowed })

  return Bool.match(allowed, {
    onFalse: () => "Subagents can no longer consult the advisor.",
    onTrue: () => "Subagents can now consult the advisor.",
  })
})

const status = Effect.fn("status")(function* status() {
  const preferences = yield* PreferenceStore

  return describe(yield* preferences.current)
})

/**
 * Carries out an `/advisor` command and returns the reply for the user.
 * @param {AdvisorCommand} command The parsed command.
 * @returns {Effect.Effect<string, never, Host | PreferenceStore>} The reply.
 */
const runCommand = (
  command: AdvisorCommand,
): Effect.Effect<string, never, Host | PreferenceStore> =>
  AdvisorCommand.$match(command, {
    Invalid: ({ input }) =>
      Effect.succeed(`Unrecognized arguments: ${input}\n\n${USAGE}`),
    SetEnabled: ({ enabled }) =>
      Bool.match(enabled, { onFalse: disable, onTrue: enable }),
    SetModel: ({ model }) =>
      setModel(model).pipe(
        Effect.catchTags({
          HostError: ({ operation }) =>
            Effect.succeed(
              `Could not list the available models (${operation} failed).`,
            ),
          InvalidModel: ({ model: rejected, reason }) =>
            Effect.succeed(
              `Cannot use ${rejected} as the advisor: ${reason}. Use the provider/model form shown by /models.`,
            ),
        }),
      ),
    SetSubagents: ({ allowed }) => setSubagents(allowed),
    Status: status,
  })

export {
  AdvisorCommand,
  COMMAND_DESCRIPTION,
  COMMAND_NAME,
  describe,
  parseCommand,
  runCommand,
}
