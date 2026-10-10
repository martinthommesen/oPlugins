import { Context, Effect, HashMap, Layer, Option, Ref, pipe } from "effect"
import BreakerDecision from "./breaker-decision.ts"
import Settings from "./settings.ts"

type Decision = Parameters<typeof BreakerDecision.$match>[typeof FIRST]

interface TurnDenials {
  readonly consecutive: number
  readonly total: number
}

interface ReviewTurn {
  readonly sessionId: string
  readonly userMessageId: string
}

interface Interface {
  /** Counts an approval, which ends a run of consecutive denials. */
  readonly recordApproval: (turn: ReviewTurn) => Effect.Effect<void>
  /** Counts a denial and decides whether the agent or the user gets it. */
  readonly recordDenial: (turn: ReviewTurn) => Effect.Effect<Decision>
}

const FIRST = 0,
  NO_DENIALS = 0,
  ONE_DENIAL = 1,
  /* The denials counted so far in the turn under `key`. */
  countsFor = (
    turns: HashMap.HashMap<string, TurnDenials>,
    key: string,
  ): TurnDenials =>
    pipe(
      HashMap.get(turns, key),
      Option.getOrElse(() => ({
        consecutive: NO_DENIALS,
        total: NO_DENIALS,
      })),
    ),
  /* Counts one more denial in the turn under `key` and decides who gets it. */
  tallyDenial =
    (settings: Settings["Service"], key: string) =>
    (
      current: HashMap.HashMap<string, TurnDenials>,
    ): readonly [Decision, HashMap.HashMap<string, TurnDenials>] => {
      const before = countsFor(current, key),
        consecutive = before.consecutive + ONE_DENIAL,
        total = before.total + ONE_DENIAL,
        updated = HashMap.set(current, key, { consecutive, total })

      if (
        consecutive >= settings.maxConsecutiveDenials ||
        total >= settings.maxTotalDenials
      ) {
        return [BreakerDecision.Escalate({ consecutive, total }), updated]
      }

      return [BreakerDecision.Deny({ consecutive, total }), updated]
    },
  /* The key one session's turn is counted under. */
  turnKey = (turn: ReviewTurn): string =>
    JSON.stringify([turn.sessionId, turn.userMessageId])

/** Shares denial counts across a root session and its subagents. */
class DenialBreaker extends Context.Service<DenialBreaker, Interface>()(
  "opencode-auto-review/denial-breaker/DenialBreaker",
) {
  public static readonly layer = Layer.effect(
    DenialBreaker,
    Effect.gen(function* makeDenialBreaker() {
      const settings = yield* Settings,
        turns = yield* Ref.make(HashMap.empty<string, TurnDenials>())

      return DenialBreaker.of({
        recordApproval: Effect.fn("DenialBreaker.recordApproval")(
          function* recordApproval(turn: ReviewTurn) {
            const key = turnKey(turn)

            yield* Ref.update(turns, (current) =>
              HashMap.set(current, key, {
                consecutive: NO_DENIALS,
                total: countsFor(current, key).total,
              }),
            )
          },
        ),
        recordDenial: Effect.fn("DenialBreaker.recordDenial")(
          function* recordDenial(turn: ReviewTurn) {
            return yield* Ref.modify(
              turns,
              tallyDenial(settings, turnKey(turn)),
            )
          },
        ),
      })
    }),
  )
}

export default DenialBreaker
