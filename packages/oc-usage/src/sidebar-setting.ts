import { Context, Effect, Layer, Option, Schema } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type sidebarState from "./sidebar-state.ts"

type Storage = Plugin.Context["storage"]

const STORAGE_KEY = "sidebar",
  /** The setting, as the plugin's storage holds it. */
  Stored = Schema.Struct({ shown: Schema.Boolean }),
  decodeStored = Schema.decodeUnknownOption(Schema.UndefinedOr(Stored)),
  /* Saves the setting in `storage`. */
  saveIn =
    (storage: Storage) =>
    (shown: boolean): Effect.Effect<void> =>
      storage.set(STORAGE_KEY, { shown }),
  /* The setting in `storage`. A value it can't read is off. */
  stateIn = (storage: Storage): Effect.Effect<typeof sidebarState.Type> =>
    storage.get(STORAGE_KEY).pipe(
      Effect.map(decodeStored),
      Effect.tap((decoded) =>
        Option.match(decoded, {
          onNone: () => Effect.logWarning("usage_sidebar_setting_unreadable"),
          onSome: () => Effect.void,
        }),
      ),
      Effect.map(
        Option.match({
          onNone: () => ({
            problem:
              "Your saved usage visibility couldn't be read. Run /show-usage on or off to replace it.",
            shown: false,
          }),
          onSome: (stored) => ({
            shown: Option.fromUndefinedOr(stored).pipe(
              Option.exists((value) => value.shown),
            ),
          }),
        }),
      ),
    )

/**
 * Whether the TUI sidebar shows the usage section. `/show-usage` sets it,
 * and the plugin's durable storage keeps it across restarts, for every
 * project.
 */
class SidebarSetting extends Context.Service<
  SidebarSetting,
  {
    /** Saves whether the sidebar shows the usage section. */
    readonly save: (shown: boolean) => Effect.Effect<void>
    /** Whether the sidebar shows the usage section; off until turned on. */
    readonly shown: Effect.Effect<boolean>
    readonly state: Effect.Effect<typeof sidebarState.Type>
  }
>()("@martinthommesen/oc-usage/sidebar-setting/SidebarSetting") {
  /* The setting in the plugin's durable storage. */
  public static readonly fromStorage = (
    storage: Storage,
  ): Layer.Layer<SidebarSetting> =>
    Layer.effect(
      SidebarSetting,
      Effect.sync(() => {
        const state = stateIn(storage)

        return SidebarSetting.of({
          save: saveIn(storage),
          shown: state.pipe(Effect.map((value) => value.shown)),
          state,
        })
      }),
    )
}

export default SidebarSetting
