import {
  Array as Arr,
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Result,
  Semaphore,
  Struct,
  pipe,
} from "effect"
import type { Duration } from "effect"
import Host from "./host.ts"
import UsageMeter from "./usage-meter.ts"
import usageEntry from "./usage-entry.ts"
import usageReport from "./usage-report.ts"

type SignIn = Option.Option.Value<
  Effect.Success<ReturnType<Host["Service"]["signIn"]>>
>

type Access = Option.Option.Value<Effect.Success<SignIn["access"]>>

type UsageRequest = Parameters<UsageMeter["Service"]["measure"]>[typeof FIRST]

type Entry = ReturnType<typeof usageEntry.after>

type State = typeof usageReport.State.Type

/** A subscription oc-usage measures, as `claude-usage.ts` describes one. */
interface Subscription extends Pick<
  UsageRequest,
  "read" | "reconnect" | "service" | "url"
> {
  /** What to do to connect the subscription. */
  readonly hint: string
  /** Why a connection that isn't an OAuth sign-in can't report usage. */
  readonly ineligible: string
  readonly integrationId: string
  /** How long oc-usage waits between two requests to the service, at least. */
  readonly interval: Duration.Duration
  /** The headers of a usage request, or the problem that stops one. */
  readonly prepare: (
    access: Access,
  ) => Result.Result<UsageRequest["headers"], string>
  readonly title: string
}

/** A subscription, and what the tracker keeps for it. */
interface Slot {
  /** The newest attempt, if there was one. */
  readonly latest: Ref.Ref<Option.Option<Entry>>
  /** Lets one attempt at a time ask the subscription's service. */
  readonly lock: Semaphore.Semaphore
  readonly subscription: Subscription
}

interface Interface {
  /**
   * Every subscription's usage. A service is asked anew only once the
   * subscription's interval has passed since its last attempt, or when the
   * connection changed account since then.
   */
  readonly report: Effect.Effect<typeof usageReport.UsageReport.Type>
}

const FIRST = 0,
  ONE_PERMIT = 1,
  /*
   * Asks the subscription's service for the usage of the connection
   * `signIn`. A connection without an OAuth sign-in can't be measured, and a
   * sign-in OpenCode couldn't renew can't be measured this time.
   */
  measured = Effect.fnUntraced(function* measured(
    subscription: Subscription,
    signIn: SignIn,
  ) {
    const meter = yield* UsageMeter

    return yield* signIn.access.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.succeed(
              UsageMeter.Outcome.Ineligible({
                reason: subscription.ineligible,
              }),
            ),
          onSome: (access) =>
            Result.match(subscription.prepare(access), {
              onFailure: (problem) =>
                Effect.succeed(UsageMeter.Outcome.Rejected({ problem })),
              onSuccess: (headers) =>
                meter.measure(Struct.assign(subscription, { headers })),
            }),
        }),
      ),
      Effect.catchTag("HostError", () =>
        Effect.succeed(
          UsageMeter.Outcome.Unreachable({
            problem: `OpenCode couldn't renew the ${subscription.service} sign-in.`,
          }),
        ),
      ),
    )
  }),
  /* A new attempt to measure the subscription in `slot`, which the tracker keeps. */
  refreshed = Effect.fnUntraced(function* refreshed(
    slot: Slot,
    signIn: SignIn,
    previous: Option.Option<Entry>,
  ) {
    const began = yield* Clock.currentTimeMillis,
      outcome = yield* measured(slot.subscription, signIn),
      stored = usageEntry.after(
        {
          identity: signIn.identity,
          interval: slot.subscription.interval,
          startedAt: began,
        },
        previous,
        outcome,
      )

    yield* Ref.set(slot.latest, Option.some(stored))

    return stored.state
  }),
  /* A kept slot for `subscription`. */
  slotOf = (subscription: Subscription): Effect.Effect<Slot> =>
    Effect.all({
      latest: Ref.make(Option.none<Entry>()),
      lock: Semaphore.make(ONE_PERMIT),
    }).pipe(Effect.map(({ latest, lock }) => ({ latest, lock, subscription }))),
  /*
   * The state of the subscription in `slot` for the connection `signIn`: the
   * kept one until its interval has passed, or a new attempt's. A kept state
   * of another account never counts.
   */
  stateFor = Effect.fnUntraced(function* stateFor(slot: Slot, signIn: SignIn) {
    const latest = yield* Ref.get(slot.latest),
      now = yield* Clock.currentTimeMillis,
      previous = latest.pipe(
        Option.filter((entry) => entry.identity === signIn.identity),
      )

    return yield* previous.pipe(
      Option.filter((entry) => now < entry.nextAt),
      Option.match({
        onNone: () => refreshed(slot, signIn, previous),
        onSome: (entry) => Effect.succeed(entry.state),
      }),
    )
  }),
  /*
   * The state of the subscription in `slot`. Attempts for one subscription
   * wait for each other, so a second request finds the first one's result.
   */
  stateOf = Effect.fnUntraced(function* stateOf(slot: Slot) {
    const host = yield* Host,
      { subscription } = slot

    return yield* host.signIn(subscription.integrationId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: (): Effect.Effect<State, never, UsageMeter> =>
            Effect.succeed(
              usageReport.Disconnected.make({ hint: subscription.hint }),
            ),
          onSome: (connected) =>
            slot.lock.withPermits(ONE_PERMIT)(stateFor(slot, connected)),
        }),
      ),
      Effect.catchTag("HostError", () =>
        Effect.succeed(
          usageReport.Failed.make({
            problem: `OpenCode couldn't read the ${subscription.service} connection.`,
          }),
        ),
      ),
    )
  }),
  /* Every subscription's usage, measured side by side. */
  usageOf = (
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
          stateOf(slot).pipe(
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

/** Keeps each subscription's newest usage, and asks for it when it's due. */
class UsageTracker extends Context.Service<UsageTracker, Interface>()(
  "@martinthommesen/oc-usage/usage-tracker/UsageTracker",
) {
  /* The tracker of `subscriptions`, in the order the report lists them. */
  public static readonly layer = (
    subscriptions: readonly Subscription[],
  ): Layer.Layer<UsageTracker, never, Host | UsageMeter> =>
    Layer.effect(
      UsageTracker,
      Effect.gen(function* makeUsageTracker() {
        const context = yield* Effect.context<Host | UsageMeter>(),
          slots = yield* pipe(
            subscriptions,
            Effect.forEach((subscription) => slotOf(subscription)),
          )

        return UsageTracker.of({
          report: usageOf(slots).pipe(Effect.provideContext(context)),
        })
      }),
    )
}

export default UsageTracker
