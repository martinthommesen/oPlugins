import { Deferred, Effect, Fiber } from "effect"
import { describe, expect, it } from "@effect/vitest"
import cliHost from "./cli-host.test-support.ts"
import tuiPlugin from "./tui.ts"

describe("command lifetime", () => {
  it.live(
    "aborts a pending command and suppresses its late dialog after unload",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const entered = yield* Deferred.make<boolean>(),
          release = yield* Deferred.make<boolean>(),
          response = Deferred.succeed(entered, true).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ subscriptions: [] }),
          ),
          subject = yield* cliHost.scoped(
            { report: response, shown: false },
            (host) => tuiPlugin.setup(host),
          ),
          waiting = yield* Effect.forkChild(subject.run("oc-usage.report"))

        yield* Deferred.await(entered)
        subject.cleanup()
        yield* Deferred.succeed(release, true)
        yield* Fiber.join(waiting)
        expect(
          subject.reportSignals.map((signal) => signal.aborted),
        ).toStrictEqual([true])
        expect(subject.alerts).toStrictEqual([])
        expect(subject.toasts).toStrictEqual([])
      }).pipe(Effect.scoped),
  )

  it.live("rejects new work when cleanup happens during initialization", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const subject = yield* cliHost.scoped(
        { report: Effect.never, shown: false },
        (host) => tuiPlugin.setup(host),
      )

      subject.cleanup()
      yield* subject.run("oc-usage.report")
      yield* subject.run("oc-usage.sidebar", "on")
      expect(subject.reportSignals).toStrictEqual([])
      expect(subject.saved).toStrictEqual([])
      expect(subject.alerts).toStrictEqual([])
    }).pipe(Effect.scoped),
  )
})
