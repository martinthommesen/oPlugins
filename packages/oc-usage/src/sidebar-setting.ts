import { Context, Effect, Layer, Option, Schema } from "effect"
import type { Plugin } from "@opencode/plugin/effect"

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
  shownIn = (storage: Storage): Effect.Effect<boolean> =>
    storage.get(STORAGE_KEY).pipe(
      Effect.map(decodeStored),
      Effect.tap((decoded) =>
        Option.match(decoded, {
          onNone: () => Effect.logWarning("usage_sidebar_setting_unreadable"),
          onSome: () => Effect.void,
        }),
      ),
      Effect.map(Option.flatMap(Option.fromUndefinedOr)),
      Effect.map(Option.exists((stored) => stored.shown)),
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
  }
>()("@martinthommesen/oc-usage/sidebar-setting/SidebarSetting") {
  /* The setting in the plugin's durable storage. */
  public static readonly fromStorage = (
    storage: Storage,
  ): Layer.Layer<SidebarSetting> =>
    Layer.succeed(
      SidebarSetting,
      SidebarSetting.of({ save: saveIn(storage), shown: shownIn(storage) }),
    )
}

export default SidebarSetting
