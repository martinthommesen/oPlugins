import { Array as Arr, Context, Effect, Layer, pipe } from "effect"
import type Host from "./host.ts"
import type UsageMeter from "./usage-meter.ts"
import type usageReport from "./usage-report.ts"
import usageState from "./usage-tracker-state.ts"

type Slot = Effect.Success<ReturnType<typeof usageState.make>>

type Subscription = Slot["subscription"]

const usageOf = (
  slots: readonly Slot[],
): Effect.Effect<
  typeof usageReport.UsageReport.Type,
  never,
  Host | UsageMeter
> =>
  Effect.all(
    pipe(
      slots,
      Arr.map((slot) =>
        usageState
          .state(slot)
          .pipe(
            Effect.map((state) => ({ state, title: slot.subscription.title })),
          ),
      ),
    ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(
      (subscriptions: readonly (typeof usageReport.Subscription.Type)[]) => ({
        subscriptions,
      }),
    ),
  )

/** Owns measurements and request reservations until the plugin's scope closes. */
class UsageTracker extends Context.Service<
  UsageTracker,
  {
    readonly report: Effect.Effect<typeof usageReport.UsageReport.Type>
  }
>()("@martinthommesen/oc-usage/usage-tracker/UsageTracker") {
  public static readonly layer = (
    subscriptions: readonly Subscription[],
  ): Layer.Layer<UsageTracker, never, Host | UsageMeter> =>
    Layer.effect(
      UsageTracker,
      Effect.gen(function* makeUsageTracker() {
        const context = yield* Effect.context<Host | UsageMeter>(),
          slots = yield* pipe(
            subscriptions,
            Effect.forEach((subscription) => usageState.make(subscription)),
          )

        return UsageTracker.of({
          report: usageOf(slots).pipe(Effect.provideContext(context)),
        })
      }),
    )
}

export default UsageTracker
