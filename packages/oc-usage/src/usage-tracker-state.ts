import {
  Clock,
  Effect,
  Option,
  Record as Rec,
  Redacted,
  Ref,
  Result,
  Semaphore,
  String as Str,
  Struct,
} from "effect"
import type { Duration } from "effect"
import Host from "./host.ts"
import HostError from "./host-error.ts"
import UsageMeter from "./usage-meter.ts"
import usageEntry from "./usage-entry.ts"
import usageReport from "./usage-report.ts"
import usageTimeouts from "./usage-timeouts.ts"

type SignIn = Option.Option.Value<
  Effect.Success<ReturnType<Host["Service"]["signIn"]>>
>

type Access = Option.Option.Value<Effect.Success<SignIn["access"]>>

type UsageRequest = Parameters<UsageMeter["Service"]["measure"]>[typeof FIRST]

type Entry = ReturnType<typeof usageEntry.after>

type Attempt = Parameters<typeof usageEntry.after>[typeof FIRST]

type State = typeof usageReport.State.Type

interface Subscription extends Pick<
  UsageRequest,
  "read" | "reconnect" | "service" | "url"
> {
  readonly account: (access: Access) => Option.Option<string>
  readonly hint: string
  readonly ineligible: string
  readonly integrationId: string
  readonly interval: Duration.Duration
  readonly prepare: (
    access: Access,
  ) => Result.Result<UsageRequest["headers"], string>
  readonly title: string
}

interface Slot {
  /* Scheduling history survives cancellation and switching connections within the owning layer. */
  readonly entries: Ref.Ref<Readonly<Record<string, Entry>>>
  readonly lock: Semaphore.Semaphore
  readonly subscription: Subscription
}

interface Resolved {
  readonly access: Option.Option<Access>
  readonly identity: string
}

interface Prepared {
  readonly attempt: Attempt
  readonly headers: UsageRequest["headers"]
  readonly previous: Option.Option<Entry>
}

const ABANDONED =
    "The usage request didn't complete. Retry /usage after the subscription's interval.",
  CHANGED =
    "The sign-in changed. Its earlier measurement was withdrawn; retry /usage after the previous request's interval.",
  FIRST = 0,
  ONE_PERMIT = 1,
  TOKENS = Object.freeze({ same: Redacted.makeEquivalence(Str.Equivalence) }),
  disconnected = (subscription: Subscription): Effect.Effect<State> =>
    Effect.succeed(usageReport.Disconnected.make({ hint: subscription.hint })),
  identityOf = (
    subscription: Subscription,
    identity: string,
    access: Access,
  ): string =>
    JSON.stringify([
      identity,
      Option.getOrElse(subscription.account(access), () => ""),
    ]),
  keep = (slot: Slot, entry: Entry): Effect.Effect<void> =>
    Ref.update(slot.entries, Rec.set(entry.identity, entry)),
  /* Cache reuse follows resolution, never an earlier display label or credential snapshot. */
  lookup = Effect.fnUntraced(function* resolveConnection(
    subscription: Subscription,
  ): Effect.fn.Return<Option.Option<Resolved>, HostError, Host> {
    const host = yield* Host

    return yield* host.signIn(subscription.integrationId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (signIn) =>
            signIn.access.pipe(
              Effect.map((access) =>
                Option.some({ access, identity: signIn.identity }),
              ),
            ),
        }),
      ),
      Effect.timeoutOrElse({
        duration: usageTimeouts.connection,
        orElse: () =>
          Effect.fail(
            HostError.make({
              category: "unavailable",
              cause: "Connection deadline exceeded",
              operation: "integration.connection.read",
            }),
          ),
      }),
    )
  }),
  /* A response remains history for its original request, not a measurement of a replaced sign-in. */
  rechecked = Effect.fnUntraced(function* recheck(
    slot: Slot,
    attempt: Attempt,
    state: State,
  ) {
    const latest = yield* lookup(slot.subscription),
      stillCurrent = latest.pipe(
        Option.flatMap((signIn) =>
          signIn.access.pipe(
            Option.map(
              (access) =>
                identityOf(slot.subscription, signIn.identity, access) ===
                  attempt.identity && TOKENS.same(access.token, attempt.token),
            ),
          ),
        ),
        Option.getOrElse(() => false),
      )

    if (!stillCurrent) {
      return usageReport.Failed.make({
        problem:
          "The sign-in changed during the usage request. Its old result was discarded; retry /usage.",
      })
    }

    return state
  }),
  /* Reserve before interruptible network work, keeping only complete, verified measurements. */
  refreshed = (
    slot: Slot,
    prepared: Prepared,
  ): Effect.Effect<State, HostError, Host | UsageMeter> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* dispatch() {
        const meter = yield* UsageMeter,
          request = restore(
            meter.measure(
              Struct.assign(slot.subscription, { headers: prepared.headers }),
            ),
          ),
          reservation = usageEntry.after(
            prepared.attempt,
            prepared.previous,
            UsageMeter.Outcome.Unreachable({ problem: ABANDONED }),
          ),
          response = yield* keep(slot, reservation).pipe(
            Effect.andThen(request),
          ),
          responseAt = yield* Clock.currentTimeMillis,
          stored = usageEntry.after(
            Struct.assign(prepared.attempt, { finishedAt: responseAt }),
            prepared.previous,
            response,
          )

        yield* keep(slot, stored)

        return yield* restore(rechecked(slot, prepared.attempt, stored.state))
      }),
    ),
  slotOf = (subscription: Subscription): Effect.Effect<Slot> =>
    Effect.all({
      entries: Ref.make<Readonly<Record<string, Entry>>>({}),
      lock: Semaphore.make(ONE_PERMIT),
    }).pipe(
      Effect.map(({ entries, lock }) => ({ entries, lock, subscription })),
    ),
  /* Any token rotation withdraws data without erasing that identity's request wait. */
  stateFor = Effect.fnUntraced(function* readGeneration(
    slot: Slot,
    signIn: Resolved,
    access: Access,
  ) {
    const entries = yield* Ref.get(slot.entries),
      identity = identityOf(slot.subscription, signIn.identity, access),
      now = yield* Clock.currentTimeMillis,
      previous = Rec.get(entries, identity),
      requestAttempt = {
        finishedAt: now,
        identity,
        interval: slot.subscription.interval,
        startedAt: now,
        token: access.token,
      },
      reusable = usageEntry.compatible(previous, requestAttempt),
      waiting = previous.pipe(Option.filter((entry) => now < entry.nextAt))

    if (Option.isSome(waiting)) {
      return Option.match(reusable, {
        onNone: () => usageReport.Failed.make({ problem: CHANGED }),
        onSome: (entry) => entry.state,
      })
    }

    return yield* Result.match(slot.subscription.prepare(access), {
      onFailure: (problem) =>
        Effect.logWarning("usage_sign_in_unusable").pipe(
          Effect.annotateLogs({ service: slot.subscription.service }),
          Effect.as(usageReport.Failed.make({ problem })),
        ),
      onSuccess: (headers) =>
        refreshed(slot, {
          attempt: requestAttempt,
          headers,
          previous: reusable,
        }),
    })
  }),
  stateResolved = (
    slot: Slot,
    signIn: Resolved,
  ): Effect.Effect<State, HostError, Host | UsageMeter> =>
    Option.match(signIn.access, {
      onNone: () =>
        Effect.succeed(
          usageReport.Ineligible.make({ reason: slot.subscription.ineligible }),
        ),
      onSome: (access) => stateFor(slot, signIn, access),
    }),
  stateSelected = (
    slot: Slot,
  ): Effect.Effect<State, never, Host | UsageMeter> =>
    lookup(slot.subscription).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => disconnected(slot.subscription),
          onSome: (signIn) => stateResolved(slot, signIn),
        }),
      ),
      Effect.catchTag("HostError", (failure: { readonly operation: string }) =>
        Effect.logWarning("usage_connection_failed").pipe(
          Effect.annotateLogs({
            operation: failure.operation,
            service: slot.subscription.service,
          }),
          Effect.as(
            usageReport.Failed.make({
              problem: `OpenCode couldn't read or renew the ${slot.subscription.service} sign-in. Retry /usage; if it persists, check usage_connection_failed or reconnect.`,
            }),
          ),
        ),
      ),
    ),
  /* The total budget also bounds callers waiting for this subscription's permit. */
  stateTracked = (slot: Slot): Effect.Effect<State, never, Host | UsageMeter> =>
    slot.lock
      .withPermits(ONE_PERMIT)(stateSelected(slot))
      .pipe(
        Effect.timeoutOrElse({
          duration: usageTimeouts.report,
          orElse: () =>
            Effect.logWarning("usage_report_timed_out").pipe(
              Effect.annotateLogs({ service: slot.subscription.service }),
              Effect.as(
                usageReport.Failed.make({
                  problem: `Reading ${slot.subscription.service} usage timed out, including waiting for another request. Retry /usage later.`,
                }),
              ),
            ),
        }),
      )

export default Object.freeze({ make: slotOf, state: stateTracked })
