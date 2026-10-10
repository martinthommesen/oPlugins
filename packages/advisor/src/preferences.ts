import { Context, Effect, Layer, Option, Record, Schema } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { Settings } from "./settings.ts"
import type { SettingsInterface } from "./settings.ts"

const STORAGE_KEY = "preferences"

/** Choices made with `/advisor`, which override the plugin options. */
const Stored = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.NonEmptyString),
  subagents: Schema.optional(Schema.Boolean),
})

type Stored = typeof Stored.Type

type Storage = Plugin.Context["storage"]

/** The advisor configuration in effect. */
interface Preferences {
  /** Whether agents may consult the advisor at all. */
  readonly enabled: boolean
  /** The advisor model as `provider/model[#variant]`. */
  readonly model: Option.Option<string>
  /** Whether subagent sessions may consult the advisor. */
  readonly subagents: boolean
}

interface Interface {
  readonly current: Effect.Effect<Preferences>
  /** Saves the given choices and returns the configuration that results. */
  readonly update: (changes: Stored) => Effect.Effect<Preferences>
}

/**
 * Combines saved choices with the plugin options they override.
 * @param {SettingsInterface} settings The plugin options.
 * @returns {(stored: Stored) => Preferences} The resolver.
 */
const resolveWith =
  (settings: SettingsInterface) =>
  (stored: Stored): Preferences => {
    const model = Option.fromUndefinedOr(stored.model).pipe(
      Option.orElse(() => settings.model),
    )

    return {
      enabled: stored.enabled ?? Option.isSome(model),
      model,
      subagents: stored.subagents ?? settings.subagents,
    }
  }

const decodeStored = Option.match({
  onNone: () => Effect.succeed<Stored>({}),
  onSome: Schema.decodeUnknownEffect(Stored),
})

/**
 * Reads the saved choices, ignoring a value this version cannot decode.
 * @param {Storage} storage The plugin's durable storage.
 * @param {string} key The storage key to read.
 * @returns {Effect.Effect<Stored>} The saved choices.
 */
const loadStored = (storage: Storage, key: string): Effect.Effect<Stored> =>
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
  )

const loadChoices = Effect.fn("loadChoices")(function* loadChoices(
  storage: Storage,
) {
  const legacy = yield* loadStored(storage, STORAGE_KEY)

  const [enabled, model, subagents] = yield* Effect.all([
    loadStored(storage, `${STORAGE_KEY}.enabled`),
    loadStored(storage, `${STORAGE_KEY}.model`),
    loadStored(storage, `${STORAGE_KEY}.subagents`),
  ])

  return {
    enabled: enabled.enabled ?? legacy.enabled,
    model: model.model ?? legacy.model,
    subagents: subagents.subagents ?? legacy.subagents,
  }
})

class PreferenceStore extends Context.Service<PreferenceStore, Interface>()(
  "opencode-advisor/PreferenceStore",
) {
  /**
   * Keeps preferences in the plugin's durable storage.
   * @param {Storage} storage The plugin's durable storage.
   * @returns {Layer.Layer<PreferenceStore, never, Settings>} The layer.
   */
  public static readonly fromStorage = (
    storage: Storage,
  ): Layer.Layer<PreferenceStore, never, Settings> =>
    Layer.effect(
      PreferenceStore,
      Effect.gen(function* makePreferenceStore() {
        const resolve = resolveWith(yield* Settings)

        const current = loadChoices(storage).pipe(Effect.map(resolve))

        const update = Effect.fn("PreferenceStore.update")(function* update(
          changes: Stored,
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
      }),
    )
}

export { PreferenceStore }

export type { Preferences }
