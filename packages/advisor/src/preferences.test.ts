import { Effect, Layer, Option } from "effect"
import { assert, describe, it } from "@effect/vitest"
import type { PluginOptions } from "@opencode/plugin/options"
import { PreferenceStore } from "./preferences.ts"
import type { Preferences } from "./preferences.ts"
import { Settings } from "./settings.ts"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { memoryStorage } from "./testing.ts"

const OPTIONS = { model: "openai/gpt-6-sol", subagents: false }

/**
 * Reads the preferences in effect for the given options and storage.
 * @param {PluginOptions} options The plugin options.
 * @param {StorageDomain} storage The plugin's storage.
 * @returns {Effect.Effect<Preferences>} The preferences.
 */
const current = (
  options: PluginOptions,
  storage: StorageDomain,
): Effect.Effect<Preferences> => {
  const store = PreferenceStore.fromStorage(storage).pipe(
    Layer.provide(Settings.fromOptions(options)),
  )

  return Effect.gen(function* readCurrent() {
    const preferences = yield* PreferenceStore

    return yield* preferences.current
  }).pipe(Effect.provide(store))
}

const usesOptions = Effect.gen(function* usesOptions() {
  const preferences = yield* current(OPTIONS, memoryStorage())

  assert.deepStrictEqual(preferences, {
    enabled: true,
    model: Option.some(OPTIONS.model),
    subagents: false,
  })
})

const overridesOptions = Effect.gen(function* overridesOptions() {
  const storage = memoryStorage()

  yield* storage.set("preferences", { enabled: false, subagents: true })

  const preferences = yield* current(OPTIONS, storage)

  assert.deepStrictEqual(preferences, {
    enabled: false,
    model: Option.some(OPTIONS.model),
    subagents: true,
  })
})

const ignoresUnreadable = Effect.gen(function* ignoresUnreadable() {
  const storage = memoryStorage()

  yield* storage.set("preferences", { enabled: "yes" })

  const preferences = yield* current({}, storage)

  assert.deepStrictEqual(preferences, {
    enabled: false,
    model: Option.none(),
    subagents: true,
  })
})

describe(PreferenceStore, () => {
  it.effect(
    "turns the advisor on when the options name a model",
    () => usesOptions,
  )

  it.effect(
    "lets /advisor choices override the options",
    () => overridesOptions,
  )

  it.effect("ignores stored values it cannot read", () => ignoresUnreadable)
})
