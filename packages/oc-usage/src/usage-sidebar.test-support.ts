import type { Context, Scope } from "effect"
import { Effect, Fiber, Layer, ManagedRuntime } from "effect"
import type UsageUnavailable from "./usage-unavailable-error.ts"
import { createComponent } from "solid-js"
import { testRender } from "@opentui/solid"
import type usageReport from "./usage-report.ts"
import usageSidebar from "./usage-sidebar.ts"

type Setup = Awaited<ReturnType<typeof testRender>>

const NO_COLOR = { intent: "default" } as const,
  SIZE = { height: 12, width: 64 },
  THEME = { text: { base: NO_COLOR, muted: NO_COLOR } },
  owned = Effect.fnUntraced(function* own(context: Context.Context<never>) {
    const runtime = ManagedRuntime.make(Layer.succeedContext(context))

    yield* Effect.addFinalizer(() => runtime.disposeEffect)

    return (program: Effect.Effect<unknown>): (() => void) => {
      const running = runtime.runFork(program)

      return () => {
        Effect.runForkWith(context)(Fiber.interrupt(running))
      }
    }
  }),
  section = Effect.fnUntraced(function* mount(
    fetch: Effect.Effect<typeof usageReport.UsageReport.Type, UsageUnavailable>,
    stamp: () => string,
  ): Effect.fn.Return<
    () => Effect.Effect<readonly string[]>,
    never,
    Scope.Scope
  > {
    const context = yield* Effect.context(),
      launch = yield* owned(context),
      setup = yield* Effect.promise((): PromiseLike<Setup> =>
        testRender(
          () =>
            createComponent(usageSidebar.section, {
              fetch,
              launch,
              stamp,
              theme: THEME,
            }),
          SIZE,
        ),
      )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setup.renderer.destroy()
      }),
    )

    return (): Effect.Effect<readonly string[]> =>
      Effect.promise((): PromiseLike<void> => setup.renderOnce()).pipe(
        Effect.andThen(
          Effect.sync(() =>
            setup
              .captureCharFrame()
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line !== ""),
          ),
        ),
      )
  })

export default Object.freeze({ section })
