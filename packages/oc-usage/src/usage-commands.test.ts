import { Effect, Function as Fn } from "effect"
import { describe, expect, it } from "@effect/vitest"
import type { Scope } from "effect"
import UsageRpc from "./usage-rpc.ts"
import UsageUnavailable from "./usage-unavailable-error.ts"
import cliHost from "./cli-host.test-support.ts"
import usageCommands from "./usage-commands.ts"

type Controls = Parameters<typeof usageCommands.usageCommands>[typeof FIRST]

type RunResult = ReturnType<Controls["run"]>

const FAILED_RECONCILIATION = Effect.fail(
    UsageUnavailable.make({
      message:
        "The setting was saved, but visibility couldn't be restored here. Retry /show-usage on.",
    }),
  ),
  FIRST = 0,
  installed = (
    shown: boolean,
    reconcile: Effect.Effect<void, UsageUnavailable>,
  ): Effect.Effect<
    Effect.Success<ReturnType<typeof cliHost.scoped>>,
    never,
    Scope.Scope
  > =>
    cliHost.scoped(
      { report: Effect.succeed({ subscriptions: [] }), shown },
      (host) => {
        host.keymap.layer(() => ({
          commands: usageCommands.usageCommands({
            connection: {
              client: host.client.rpc(UsageRpc),
              location: host.data.location.default(),
            },
            reconcile,
            run: (program): RunResult =>
              Effect.runPromise(program.pipe(Effect.asVoid)),
            shown: () => false,
            ui: host.ui,
          }),
          mode: "global",
        }))

        return Fn.constVoid
      },
    )

describe("visibility command feedback", () => {
  it.effect(
    "does not claim success when the save succeeds but reconciliation fails",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const subject = yield* installed(false, FAILED_RECONCILIATION)

        yield* subject.run("oc-usage.sidebar", "on")
        expect(subject.saved).toStrictEqual([true])
        expect(subject.toasts).toStrictEqual([
          {
            message:
              "The setting was saved, but visibility couldn't be restored here. Retry /show-usage on.",
            variant: "error",
          },
        ])
      }).pipe(Effect.scoped),
  )
})

describe("visibility toggle", () => {
  it.effect(
    "toggles the saved setting instead of the window's unrestored default",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const subject = yield* installed(true, Effect.void)

        yield* subject.run("oc-usage.sidebar")
        expect(subject.saved).toStrictEqual([false])
        expect(subject.toasts).toStrictEqual([
          { message: "Usage is no longer in the sidebar.", variant: "success" },
        ])
      }).pipe(Effect.scoped),
  )
})

describe("superseded visibility save", () => {
  it.effect(
    "describes the reconciled window instead of claiming the earlier saved value is shown",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const subject = yield* installed(false, Effect.void)

        yield* subject.run("oc-usage.sidebar", "on")
        expect(subject.saved).toStrictEqual([true])
        expect(subject.toasts).toStrictEqual([
          {
            message:
              "Usage visibility changed while confirming the save. This window is currently hiding usage.",
            variant: "warning",
          },
        ])
      }).pipe(Effect.scoped),
  )
})
