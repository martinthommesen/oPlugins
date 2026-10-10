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
const current = Effect.fn("current")(function* current(
  options: PluginOptions,
  storage: StorageDomain,
): Effect.fn.Return<Preferences> {
  const store = PreferenceStore.fromStorage(storage).pipe(
    Layer.provide(Settings.fromOptions(options)),
  )

  const preferences = yield* Effect.service(PreferenceStore).pipe(
    Effect.provide(store),
  )

  return yield* preferences.current
})

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

const preservesConcurrentUpdates = Effect.gen(
  function* preservesConcurrentUpdates() {
    const storage = memoryStorage()

    const interleaved: StorageDomain = {
      get: (key) => storage.get(key).pipe(Effect.tap(() => Effect.yieldNow)),
      remove: storage.remove,
      scan: storage.scan,
      set: storage.set,
    }

    const layer = PreferenceStore.fromStorage(interleaved).pipe(
      Layer.provide(Settings.fromOptions(OPTIONS)),
    )

    const readStore = Effect.service(PreferenceStore)

    const store = yield* readStore.pipe(Effect.provide(Layer.fresh(layer)))

    const other = yield* readStore.pipe(Effect.provide(Layer.fresh(layer)))

    yield* Effect.all(
      [store.update({ enabled: false }), other.update({ subagents: true })],
      { concurrency: "unbounded" },
    )

    const preferences = yield* current(OPTIONS, storage)

    assert.isFalse(preferences.enabled)
    assert.isTrue(preferences.subagents)
  },
)

const preservesLegacyChoices = Effect.gen(function* preservesLegacyChoices() {
  const storage = memoryStorage()

  yield* storage.set("preferences", {
    enabled: false,
    model: "anthropic/claude-opus-5-5",
    subagents: false,
  })

  const layer = PreferenceStore.fromStorage(storage).pipe(
    Layer.provide(Settings.fromOptions(OPTIONS)),
  )

  const store = yield* Effect.service(PreferenceStore).pipe(
    Effect.provide(layer),
  )

  yield* store.update({ subagents: true })

  assert.deepStrictEqual(yield* current(OPTIONS, storage), {
    enabled: false,
    model: Option.some("anthropic/claude-opus-5-5"),
    subagents: true,
  })
})

const isolatesUnreadableChoices = Effect.gen(
  function* isolatesUnreadableChoices() {
    const storage = memoryStorage()

    yield* storage.set("preferences.enabled", { enabled: false })
    yield* storage.set("preferences.subagents", { subagents: "yes" })

    const preferences = yield* current(OPTIONS, storage)

    assert.isFalse(preferences.enabled)
    assert.isFalse(preferences.subagents)
  },
)

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

  it.effect(
    "does not lose changes from concurrent commands",
    () => preservesConcurrentUpdates,
  )
  it.effect(
    "preserves old stored choices when one field changes",
    () => preservesLegacyChoices,
  )
  it.effect(
    "does not discard valid choices when another field is unreadable",
    () => isolatesUnreadableChoices,
  )
})
