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
import Host from "./host.ts"
import PreferenceStore from "./preference-store.ts"
import modelRef from "./model-ref.ts"

type Preferences = Effect.Success<PreferenceStore["Service"]["current"]>

/** What an `/advisor` invocation asks for. */
type Action =
  | { readonly _tag: "Invalid"; readonly input: string }
  | { readonly _tag: "SetEnabled"; readonly enabled: boolean }
  | { readonly _tag: "SetModel"; readonly model: string }
  | { readonly _tag: "SetSubagents"; readonly allowed: boolean }
  | { readonly _tag: "Status" }

const AdvisorCommand = Data.taggedEnum<Action>(),
  COMMAND_DESCRIPTION =
    "Configure the advisor model: /advisor [provider/model | on | off | subagents on|off]",
  COMMAND_NAME = "advisor",
  USAGE = [
    "Usage:",
    "  /advisor                     show the current advisor",
    "  /advisor <provider/model>    set the advisor model and turn it on",
    "  /advisor on | off            turn the advisor on or off",
    "  /advisor subagents on | off  let subagents consult the advisor, or not",
  ].join("\n"),
  allowSubagents = Effect.fn("AdvisorCommand.setSubagents")(
    function* setSubagents(allowed: boolean) {
      const preferences = yield* PreferenceStore

      yield* preferences.update({ subagents: allowed })

      return Bool.match(allowed, {
        onFalse: () => "Subagents can no longer consult the advisor.",
        onTrue: () => "Subagents can now consult the advisor.",
      })
    },
  ),
  chooseModel = Effect.fn("AdvisorCommand.setModel")(function* setModel(
    model: string,
  ) {
    const host = yield* Host,
      preferences = yield* PreferenceStore,
      ref = yield* modelRef.parseModelRef(model)

    yield* modelRef.findModel(ref, model, yield* host.models)

    yield* preferences.update({ enabled: true, model })

    return `Advisor set to ${model}.`
  }),
  /*
   * The report `/advisor` shows: the model, whether it is on, whether
   * subagents may consult it, and the usage.
   */
  describeStatus = (preferences: Preferences): string => {
    const mode = Bool.match(preferences.enabled, {
        onFalse: () => "off",
        onTrue: () => "on",
      }),
      selected = Option.match(preferences.model, {
        onNone: () => "not set",
        onSome: (model) => `${model} (${mode})`,
      }),
      subagents = Bool.match(preferences.subagents, {
        onFalse: () => "not allowed",
        onTrue: () => "allowed",
      })

    return [`Advisor: ${selected}`, `Subagents: ${subagents}`, "", USAGE].join(
      "\n",
    )
  },
  disable = Effect.fn("AdvisorCommand.disable")(function* disable() {
    const preferences = yield* PreferenceStore

    yield* preferences.update({ enabled: false })

    return "Advisor turned off."
  }),
  enable = Effect.fn("AdvisorCommand.enable")(function* enable() {
    const preferences = yield* PreferenceStore,
      { model } = yield* preferences.current

    if (Option.isNone(model)) {
      return "No advisor model is set. Choose one with /advisor <provider/model>."
    }

    yield* preferences.update({ enabled: true })

    return `Advisor turned on (${model.value}).`
  }),
  /*
   * Reads arguments that are not a keyword: no word asks for the status, and
   * a single word is a model reference.
   */
  modelCommand = (words: readonly string[], input: string): Action =>
    Arr.match(words, {
      onEmpty: () => AdvisorCommand.Status(),
      onNonEmpty: ([model, ...rest]) =>
        Arr.match(rest, {
          onEmpty: () => AdvisorCommand.SetModel({ model }),
          onNonEmpty: () => AdvisorCommand.Invalid({ input }),
        }),
    }),
  /* Parses the text after `/advisor`. */
  parseCommand = (input: string): Action => {
    const args = pipe(
        Str.split(Str.trim(input), /\s+/u),
        Arr.filter(Str.isNonEmpty),
      ),
      normalized = Str.toLowerCase(pipe(args, Arr.join(" ")))

    return Match.value(normalized).pipe(
      Match.when("status", () => AdvisorCommand.Status()),
      Match.when("on", () => AdvisorCommand.SetEnabled({ enabled: true })),
      Match.when("off", () => AdvisorCommand.SetEnabled({ enabled: false })),
      Match.when("subagents on", () =>
        AdvisorCommand.SetSubagents({ allowed: true }),
      ),
      Match.when("subagents off", () =>
        AdvisorCommand.SetSubagents({ allowed: false }),
      ),
      Match.orElse(() => modelCommand(args, input)),
    )
  },
  report = Effect.fn("AdvisorCommand.status")(function* status() {
    const preferences = yield* PreferenceStore

    return describeStatus(yield* preferences.current)
  }),
  /* Carries out an `/advisor` command and returns the reply for the user. */
  runCommand = (
    command: Action,
  ): Effect.Effect<string, never, Host | PreferenceStore> =>
    AdvisorCommand.$match(command, {
      Invalid: ({ input }) =>
        Effect.succeed(
          `The /advisor command doesn't accept "${input}". Use one of the forms below.\n\n${USAGE}`,
        ),
      SetEnabled: ({ enabled }) =>
        Bool.match(enabled, { onFalse: disable, onTrue: enable }),
      SetModel: ({ model }) =>
        chooseModel(model).pipe(
          Effect.catchTags({
            HostError: (failure: { readonly operation: string }) =>
              Effect.succeed(
                `Couldn't list the available models because ${failure.operation} failed. Run the command again.`,
              ),
            InvalidModel: (failure: {
              readonly model: string
              readonly reason: string
            }) =>
              Effect.succeed(
                `Can't use ${failure.model} as the advisor: ${failure.reason}. Use the provider/model form that /models shows.`,
              ),
          }),
        ),
      SetSubagents: ({ allowed }) => allowSubagents(allowed),
      Status: report,
    })

/** The `/advisor` command: parsing it and carrying it out. */
export default Object.freeze({
  AdvisorCommand,
  COMMAND_DESCRIPTION,
  COMMAND_NAME,
  parseCommand,
  runCommand,
})
