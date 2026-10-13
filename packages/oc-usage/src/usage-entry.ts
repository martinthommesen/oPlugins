import { Duration, Match, Option, Struct } from "effect"
import type { Effect } from "effect"
import UsageMeter from "./usage-meter.ts"
import usageReport from "./usage-report.ts"

type Outcome = Effect.Success<ReturnType<UsageMeter["Service"]["measure"]>>

type State = typeof usageReport.State.Type

type Measured = typeof usageReport.Measured.Type

/** What the tracker keeps of a subscription's newest attempt. */
interface Entry {
  /** The identity of the connection the attempt was for. */
  readonly identity: string
  /** When oc-usage may next ask the service, in epoch milliseconds. */
  readonly nextAt: number
  readonly state: State
}

/** One attempt: the connection it's for, and when it started. */
interface Attempt {
  readonly identity: string
  readonly interval: Duration.Duration
  readonly startedAt: number
}

/* The measurement `state` holds, if it holds one. */
const asMeasured = (state: State): Option.Option<Measured> =>
    Match.value(state).pipe(
      Match.tag("Measured", (measured) => Option.some(measured)),
      Match.orElse(() => Option.none()),
    ),
  /*
   * The state after an attempt that failed with `problem`: the earlier
   * measurement with the problem, or the problem alone.
   */
  degraded = (previous: Option.Option<Entry>, problem: string): State =>
    previous.pipe(
      Option.flatMap((entry) => asMeasured(entry.state)),
      Option.match({
        onNone: () => usageReport.Failed.make({ problem }),
        onSome: (measured) =>
          Struct.assign(measured, { problem: Option.some(problem) }),
      }),
    ),
  /* What the tracker keeps after `attempt` came to `outcome`. */
  entryAfter = (
    attempt: Attempt,
    previous: Option.Option<Entry>,
    outcome: Outcome,
  ): Entry => {
    const compatible = previous.pipe(
        Option.filter((entry) => entry.identity === attempt.identity),
      ),
      keep = (wait: Duration.Duration, state: State): Entry => ({
        identity: attempt.identity,
        nextAt: attempt.startedAt + Duration.toMillis(wait),
        state,
      })

    return UsageMeter.Outcome.$match(outcome, {
      Ineligible: ({ reason }) =>
        keep(attempt.interval, usageReport.Ineligible.make({ reason })),
      Limited: ({ problem, wait }) =>
        keep(
          Duration.max(attempt.interval, wait),
          degraded(compatible, problem),
        ),
      Read: ({ reading }) =>
        keep(
          attempt.interval,
          usageReport.Measured.make({
            measuredAt: attempt.startedAt,
            plan: reading.plan,
            problem: Option.none(),
            windows: reading.windows,
          }),
        ),
      Rejected: ({ problem }) =>
        keep(attempt.interval, usageReport.Failed.make({ problem })),
      Unreachable: ({ problem }) =>
        keep(attempt.interval, degraded(compatible, problem)),
    })
  }

/** How the outcome of an attempt turns into what the tracker keeps. */
export default Object.freeze({ after: entryAfter })
