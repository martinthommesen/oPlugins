import { Effect, Option } from "effect"
import { assert, describe, it as test } from "@effect/vitest"
import PreferenceStore from "./preference-store.ts"
import type { Scope } from "effect"
import Settings from "./settings.ts"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import type { Vitest } from "@effect/vitest"
import support from "./advisor.test-support.ts"

type Preferences = Effect.Success<PreferenceStore["Service"]["current"]>

/** The tests in a block that provides the plugin options. */
interface Tests {
  readonly effect: Vitest.Test<Settings | Scope.Scope>
}

const OPTIONS = { model: "openai/gpt-6-sol", subagents: false },
  /* The preferences in effect for the block's options and `storage`. */
  current = (
    storage: StorageDomain,
  ): Effect.Effect<Preferences, never, Settings> =>
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
  isolatesUnreadableChoices = Effect.gen(function* isolatesUnreadableChoices() {
    const preferences = yield* current(
      support.memoryStorage([
        ["preferences.enabled", { enabled: false }],
        ["preferences.subagents", { subagents: "yes" }],
      ]),
    )

    assert.isFalse(preferences.enabled)
    assert.isFalse(preferences.subagents)
  }),
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
  preservesLegacyChoices = Effect.gen(function* preservesLegacyChoices() {
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
  }),
  usesOptions = Effect.gen(function* usesOptions() {
    const preferences = yield* current(support.memoryStorage())

    assert.deepStrictEqual(preferences, {
      enabled: true,
      model: Option.some(OPTIONS.model),
      subagents: false,
    })
  })

describe("preference store", () => {
  test.layer(Settings.fromOptions(OPTIONS))((it: Tests) => {
    it.effect(
      "turns the advisor on when the options name a model",
      () => usesOptions,
    )
  })

  test.layer(Settings.fromOptions(OPTIONS))((it: Tests) => {
    it.effect(
      "lets /advisor choices override the options",
      () => overridesOptions,
    )
  })

  test.layer(Settings.fromOptions({}))((it: Tests) => {
    it.effect("ignores stored values it cannot read", () => ignoresUnreadable)
  })

  test.layer(Settings.fromOptions(OPTIONS))((it: Tests) => {
    it.effect(
      "does not lose changes from concurrent commands",
      () => preservesConcurrentUpdates,
    )
  })

  test.layer(Settings.fromOptions(OPTIONS))((it: Tests) => {
    it.effect(
      "preserves old stored choices when one field changes",
      () => preservesLegacyChoices,
    )
  })

  test.layer(Settings.fromOptions(OPTIONS))((it: Tests) => {
    it.effect(
      "does not discard valid choices when another field is unreadable",
      () => isolatesUnreadableChoices,
    )
  })
})
