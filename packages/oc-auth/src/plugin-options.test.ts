import { Effect, Option } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import type { Vitest } from "@effect/vitest"
import fakeHost from "./fake-host.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given the fake host. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<typeof fakeHost.domains>> | Scope.Scope
  >
}

const COOLDOWN_MS = 15_000,
  KNOWN_OPTIONS =
    "betaFlags, cliVersion, cost, entrypoint, refreshCooldownMs, refreshLockTtlMs, userAgent",
  NO_LEASE_MS = 0,
  /* The message setup fails with when the options have `problems`. */
  failureNaming = (problems: string): Option.Option<string> =>
    Option.some(
      `oc-auth did not start because its options in opencode.jsonc are invalid. ${problems} Correct the options, then restart OpenCode.`,
    ),
  /* A host with no active connection. */
  host = fakeHost.domains(Option.none())

describe("plugin options of the wrong type", () => {
  test.layer(host)((it: Tests) => {
    it.effect("fails setup on a number given as a string", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(
          yield* fakeHost.optionsFailure({ refreshCooldownMs: "15000" }),
        ).toStrictEqual(failureNaming("refreshCooldownMs: Expected number."))
      }),
    )
  })
})

describe("plugin options out of range", () => {
  test.layer(host)((it: Tests) => {
    it.effect("fails setup on a lease that is not positive", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(
          yield* fakeHost.optionsFailure({ refreshLockTtlMs: NO_LEASE_MS }),
        ).toStrictEqual(
          failureNaming("refreshLockTtlMs: Expected a value greater than 0."),
        )
      }),
    )
  })
})

describe("plugin options with an unknown name", () => {
  test.layer(host)((it: Tests) => {
    it.effect("fails setup and lists the options there are", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(
          yield* fakeHost.optionsFailure({ refresh_cooldown_ms: COOLDOWN_MS }),
        ).toStrictEqual(
          failureNaming(
            `refresh_cooldown_ms: Unknown option (known: ${KNOWN_OPTIONS}).`,
          ),
        )
      }),
    )
  })
})
