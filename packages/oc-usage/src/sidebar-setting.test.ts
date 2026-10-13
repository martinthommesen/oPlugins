import { Context, Effect, Layer } from "effect"
import { describe, expect, it } from "@effect/vitest"
import SidebarSetting from "./sidebar-setting.ts"
import hostFakes from "./plugin-host.test-support.ts"

type Storage = Parameters<typeof SidebarSetting.fromStorage>[typeof FIRST]

const FIRST = 0,
  /* What `run` comes to with the setting in `storage`. */
  withSetting = <Value>(
    storage: Storage,
    run: (setting: SidebarSetting["Service"]) => Effect.Effect<Value>,
  ): Effect.Effect<Value> =>
    Layer.build(SidebarSetting.fromStorage(storage)).pipe(
      Effect.map((built) => Context.get(built, SidebarSetting)),
      Effect.flatMap(run),
      Effect.scoped,
    )

describe("the sidebar setting", () => {
  it.effect("is off until it's turned on, and keeps what was saved", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const storage = hostFakes.memoryStorage(),
        values = yield* Effect.all([
          withSetting(storage, (setting) => setting.shown),
          withSetting(storage, (setting) =>
            setting.save(true).pipe(Effect.andThen(setting.shown)),
          ),
          withSetting(storage, (setting) =>
            setting.save(false).pipe(Effect.andThen(setting.shown)),
          ),
        ])

      expect(values).toStrictEqual([false, true, false])
    }),
  )

  it.effect("is off when the stored value can't be read", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      expect(
        yield* withSetting(
          hostFakes.memoryStorage([["sidebar", { shown: "yes" }]]),
          (setting) => setting.shown,
        ),
      ).toBe(false)
    }),
  )
})
