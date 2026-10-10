import { Context, Effect, Layer, Option, Record, Schema } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import Settings from "./settings.ts"

type Storage = Plugin.Context["storage"]

type Choices = typeof Stored.Type

/** The advisor configuration in effect. */
interface Preferences {
  /** Whether agents may consult the advisor at all. */
  readonly enabled: boolean
  /** The advisor model as `provider/model[#variant]`. */
  readonly model: Option.Option<string>
  /** Whether subagent sessions may consult the advisor. */
  readonly subagents: boolean
}

const STORAGE_KEY = "preferences",
  /** Choices made with `/advisor`, which override the plugin options. */
  Stored = Schema.Struct({
    enabled: Schema.optional(Schema.Boolean),
    model: Schema.optional(Schema.NonEmptyString),
    subagents: Schema.optional(Schema.Boolean),
  }),
  decodeStored = Option.match({
    onNone: () => Effect.succeed<Choices>({}),
    onSome: Schema.decodeUnknownEffect(Stored),
  }),
  /* Reads the saved choices under `key`, ignoring a value this version cannot decode. */
  loadStored = (storage: Storage, key: string): Effect.Effect<Choices> =>
    storage.get(key).pipe(
      Effect.map(Option.fromUndefinedOr),
      Effect.flatMap(decodeStored),
      Effect.catchTag("SchemaError", (failure) =>
        Effect.as(
          Effect.logWarning(
            "Ignoring unreadable advisor preferences",
            key,
            failure,
          ),
          {},
        ),
      ),
    ),
  /* Reads every saved choice, preferring its own key over the legacy record. */
  readChoices = Effect.fn("loadChoices")(function* loadChoices(
    storage: Storage,
  ) {
    const legacy = yield* loadStored(storage, STORAGE_KEY),
      [enabled, model, subagents] = yield* Effect.all([
        loadStored(storage, `${STORAGE_KEY}.enabled`),
        loadStored(storage, `${STORAGE_KEY}.model`),
        loadStored(storage, `${STORAGE_KEY}.subagents`),
      ])

    return {
      enabled: enabled.enabled ?? legacy.enabled,
      model: model.model ?? legacy.model,
      subagents: subagents.subagents ?? legacy.subagents,
    }
  }),
  /* Combines saved choices with the plugin options they override. */
  resolveWith =
    (settings: Settings["Service"]) =>
    (stored: Choices): Preferences => {
      const model = Option.fromUndefinedOr(stored.model).pipe(
        Option.orElse(() => settings.model),
      )

      return {
        enabled: stored.enabled ?? Option.isSome(model),
        model,
        subagents: stored.subagents ?? settings.subagents,
      }
    }

/** The `/advisor` choices, kept in the plugin's durable storage. */
class PreferenceStore extends Context.Service<
  PreferenceStore,
  {
    readonly current: Effect.Effect<Preferences>
    /** Saves the given choices and returns the configuration that results. */
    readonly update: (changes: Choices) => Effect.Effect<Preferences>
  }
>()("opencode-advisor/preference-store/PreferenceStore") {
  /** Builds a store on the plugin's durable storage. */
  public static readonly make = Effect.fn("PreferenceStore.make")(
    function* makePreferenceStore(storage: Storage) {
      const applyOptions = resolveWith(yield* Settings),
        current = readChoices(storage).pipe(Effect.map(applyOptions)),
        update = Effect.fn("PreferenceStore.update")(function* update(
          changes: Choices,
        ) {
          // Separate keys preserve unrelated choices from concurrent commands.
          const values = {
            enabled: changes.enabled,
            model: changes.model,
            subagents: changes.subagents,
          }

          yield* Effect.all(
            Record.collect(values, (key, value) =>
              Option.match(Option.fromUndefinedOr(value), {
                onNone: () => Effect.void,
                onSome: (choice) =>
                  storage.set(`${STORAGE_KEY}.${key}`, { [key]: choice }),
              }),
            ),
          )

          return yield* current
        })

      return PreferenceStore.of({
        current,
        update,
      })
    },
  )

  /* Keeps preferences in the plugin's durable storage. */
  public static readonly fromStorage = (
    storage: Storage,
  ): Layer.Layer<PreferenceStore, never, Settings> =>
    Layer.effect(PreferenceStore, PreferenceStore.make(storage))
}

export default PreferenceStore
