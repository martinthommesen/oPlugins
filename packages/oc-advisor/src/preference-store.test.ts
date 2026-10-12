import { Effect, Option } from "effect"
import { assert, describe, it as test } from "@effect/vitest"
import PluginOptions from "./plugin-options.ts"
import PreferenceStore from "./preference-store.ts"
import type { Scope } from "effect"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import type { Vitest } from "@effect/vitest"
import support from "./advisor.test-support.ts"

type Preferences = Effect.Success<PreferenceStore["Service"]["current"]>

/** The tests in a block that provides the plugin options. */
interface Tests {
  readonly effect: Vitest.Test<PluginOptions | Scope.Scope>
}

const OPTIONS = { model: "openai/gpt-6-sol", subagents: false },
  /* The preferences in effect for the block's options and `storage`. */
  current = (
    storage: StorageDomain,
  ): Effect.Effect<Preferences, never, PluginOptions> =>
    PreferenceStore.make(storage).pipe(
      Effect.flatMap((store) => store.current),
    ),
  ignoresUnreadable = Effect.gen(function* ignoresUnreadable() {
    const preferences = yield* current(
      support.memoryStorage([["preferences", { enabled: "yes" }]]),
    )

    assert.deepStrictEqual(preferences, {
      enabled: false,
      model: Option.none(),
      subagents: true,
    })
  }),
  isolatesUnreadablePreferences = Effect.gen(
    function* isolatesUnreadablePreferences() {
      const preferences = yield* current(
        support.memoryStorage([
          ["preferences.enabled", { enabled: false }],
          ["preferences.subagents", { subagents: "yes" }],
        ]),
      )

      assert.isFalse(preferences.enabled)
      assert.isFalse(preferences.subagents)
    },
  ),
  overridesOptions = Effect.gen(function* overridesOptions() {
    const preferences = yield* current(
      support.memoryStorage([
        ["preferences", { enabled: false, subagents: true }],
      ]),
    )

    assert.deepStrictEqual(preferences, {
      enabled: false,
      model: Option.some(OPTIONS.model),
      subagents: true,
    })
  }),
  preservesConcurrentUpdates = Effect.gen(
    function* preservesConcurrentUpdates() {
      const backing = support.memoryStorage(),
        interleaved: StorageDomain = {
          get: (key) =>
            backing.get(key).pipe(Effect.tap(() => Effect.yieldNow)),
          remove: backing.remove,
          scan: backing.scan,
          set: backing.set,
        },
        [store, other] = yield* Effect.all([
          PreferenceStore.make(interleaved),
          PreferenceStore.make(interleaved),
        ]),
        outcome = yield* Effect.all(
          [store.update({ enabled: false }), other.update({ subagents: true })],
          { concurrency: "unbounded" },
        ).pipe(Effect.andThen(current(backing)))

      assert.isFalse(outcome.enabled)
      assert.isTrue(outcome.subagents)
    },
  ),
  preservesLegacyPreferences = Effect.gen(
    function* preservesLegacyPreferences() {
      const storage = support.memoryStorage([
          [
            "preferences",
            {
              enabled: false,
              model: "anthropic/claude-opus-5-5",
              subagents: false,
            },
          ],
        ]),
        store = yield* PreferenceStore.make(storage)

      yield* store.update({ subagents: true })

      assert.deepStrictEqual(yield* current(storage), {
        enabled: false,
        model: Option.some("anthropic/claude-opus-5-5"),
        subagents: true,
      })
    },
  ),
  usesOptions = Effect.gen(function* usesOptions() {
    const preferences = yield* current(support.memoryStorage())

    assert.deepStrictEqual(preferences, {
      enabled: true,
      model: Option.some(OPTIONS.model),
      subagents: false,
    })
  })

describe("preference store", () => {
  test.layer(PluginOptions.fromOptions(OPTIONS))((it: Tests) => {
    it.effect(
      "turns the advisor on when the options name a model",
      () => usesOptions,
    )
  })

  test.layer(PluginOptions.fromOptions(OPTIONS))((it: Tests) => {
    it.effect(
      "lets /advisor preferences override the options",
      () => overridesOptions,
    )
  })

  test.layer(PluginOptions.fromOptions({}))((it: Tests) => {
    it.effect("ignores stored values it cannot read", () => ignoresUnreadable)
  })

  test.layer(PluginOptions.fromOptions(OPTIONS))((it: Tests) => {
    it.effect(
      "does not lose changes from concurrent commands",
      () => preservesConcurrentUpdates,
    )
  })

  test.layer(PluginOptions.fromOptions(OPTIONS))((it: Tests) => {
    it.effect(
      "preserves old stored preferences when one field changes",
      () => preservesLegacyPreferences,
    )
  })

  test.layer(PluginOptions.fromOptions(OPTIONS))((it: Tests) => {
    it.effect(
      "does not discard valid preferences when another field is unreadable",
      () => isolatesUnreadablePreferences,
    )
  })
})
