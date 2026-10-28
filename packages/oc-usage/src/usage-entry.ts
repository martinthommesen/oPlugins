import {
  Duration,
  Match,
  Option,
  Redacted,
  String as Str,
  Struct,
} from "effect"
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
  /** Server-local generation marker; never encoded in a report or used as a key. */
  readonly token: Redacted.Redacted
}

/** One attempt: the connection it's for, and when it started. */
interface Attempt {
  readonly identity: string
  readonly interval: Duration.Duration
  readonly startedAt: number
  readonly finishedAt: number
  readonly token: Redacted.Redacted
}

/* The measurement `state` holds, if it holds one. */
const MAX_TIME = Number.MAX_SAFE_INTEGER,
  TOKENS = Object.freeze({ same: Redacted.makeEquivalence(Str.Equivalence) }),
  asMeasured = (state: State): Option.Option<Measured> =>
    Match.value(state).pipe(
      Match.tag("Measured", (measured) => Option.some(measured)),
      Match.orElse(() => Option.none()),
    ),
  /* A measurement can be retained only for the resolved credential generation. */
  compatibleWith = (
    previous: Option.Option<Entry>,
    attempt: Attempt,
  ): Option.Option<Entry> =>
    previous.pipe(
      Option.filter(
        (entry) =>
          entry.identity === attempt.identity &&
          TOKENS.same(entry.token, attempt.token),
      ),
    ),
  /* A failed or abandoned request retains only a verified generation's measurement. */
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
    const compatible = compatibleWith(previous, attempt),
      keep = (until: number, state: State): Entry => ({
        identity: attempt.identity,
        nextAt: Math.min(MAX_TIME, until),
        state,
        token: attempt.token,
      }),
      minimum = attempt.startedAt + Duration.toMillis(attempt.interval)

    return UsageMeter.Outcome.$match(outcome, {
      Ineligible: ({ reason }) =>
        keep(minimum, usageReport.Ineligible.make({ reason })),
      Limited: ({ problem, wait }) =>
        keep(
          Math.max(minimum, attempt.finishedAt + Duration.toMillis(wait)),
          degraded(compatible, problem),
        ),
      Read: ({ reading }) =>
        keep(
          minimum,
          usageReport.Measured.make({
            measuredAt: attempt.startedAt,
            plan: reading.plan,
            problem: Option.none(),
            windows: reading.windows,
          }),
        ),
      Rejected: ({ problem }) =>
        keep(minimum, usageReport.Failed.make({ problem })),
      Unreachable: ({ problem }) =>
        keep(minimum, degraded(compatible, problem)),
    })
  }

/** How the outcome of an attempt turns into what the tracker keeps. */
export default Object.freeze({ after: entryAfter, compatible: compatibleWith })
