import { Context, Effect, Layer, Option, Record, Schema } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import PluginOptions from "./plugin-options.ts"

type Storage = Plugin.Context["storage"]

type SavedPreferences = typeof Stored.Type

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
  /** Preferences set with `/advisor`, which override the plugin options. */
  Stored = Schema.Struct({
    /** Whether `/advisor on` or `/advisor off` was last chosen. */
    enabled: Schema.optional(Schema.Boolean),
    /** The model chosen with `/advisor <provider/model>`. */
    model: Schema.optional(Schema.NonEmptyString),
    /** Whether `/advisor subagents on` or `off` was last chosen. */
    subagents: Schema.optional(Schema.Boolean),
  }),
  decodeStored = Option.match({
    onNone: () => Effect.succeed<SavedPreferences>({}),
    onSome: Schema.decodeUnknownEffect(Stored),
  }),
  /*
   * Reads the saved preferences under `key`, ignoring a value this version
   * cannot decode. The warning names the key only, not the stored value.
   */
  loadStored = (
    storage: Storage,
    key: string,
  ): Effect.Effect<SavedPreferences> =>
    storage.get(key).pipe(
      Effect.map(Option.fromUndefinedOr),
      Effect.flatMap(decodeStored),
      Effect.catchTag("SchemaError", () =>
        Effect.logWarning("advisor_preferences_unreadable").pipe(
          Effect.annotateLogs({ key }),
          Effect.as({}),
        ),
      ),
    ),
  /* Reads every saved preference, preferring its own key over the legacy record. */
  readPreferences = Effect.fn("PreferenceStore.readPreferences")(
    function* readPreferences(storage: Storage) {
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
    },
  ),
  /* Combines saved preferences with the plugin options they override. */
  resolveWith =
    (options: PluginOptions["Service"]) =>
    (stored: SavedPreferences): Preferences => {
      const model = Option.fromUndefinedOr(stored.model).pipe(
        Option.orElse(() => options.model),
      )

      return {
        enabled: stored.enabled ?? Option.isSome(model),
        model,
        subagents: stored.subagents ?? options.subagents,
      }
    }

/** The `/advisor` preferences, kept in the plugin's durable storage. */
class PreferenceStore extends Context.Service<
  PreferenceStore,
  {
    /** The configuration in effect: the saved preferences over the plugin options. */
    readonly current: Effect.Effect<Preferences>
    /** Saves the given preferences and returns the configuration that results. */
    readonly update: (changes: SavedPreferences) => Effect.Effect<Preferences>
  }
>()("@martinthommesen/oc-advisor/preference-store/PreferenceStore") {
  /** Builds a store on the plugin's durable storage. */
  public static readonly make = Effect.fn("PreferenceStore.make")(
    function* makePreferenceStore(storage: Storage) {
      const applyOptions = resolveWith(yield* PluginOptions),
        current = readPreferences(storage).pipe(Effect.map(applyOptions)),
        update = Effect.fn("PreferenceStore.update")(function* update(
          changes: SavedPreferences,
        ) {
          // Separate keys preserve unrelated preferences from concurrent commands.
          const values = {
            enabled: changes.enabled,
            model: changes.model,
            subagents: changes.subagents,
          }

          yield* Effect.all(
            Record.collect(values, (key, value) =>
              Option.match(Option.fromUndefinedOr(value), {
                onNone: () => Effect.void,
                onSome: (preference) =>
                  storage.set(`${STORAGE_KEY}.${key}`, { [key]: preference }),
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

  /* The store on the plugin's durable storage, as a layer. */
  public static readonly fromStorage = (
    storage: Storage,
  ): Layer.Layer<PreferenceStore, never, PluginOptions> =>
    Layer.effect(PreferenceStore, PreferenceStore.make(storage))
}

export default PreferenceStore
