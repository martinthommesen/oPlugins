import {
  Context,
  Data,
  Effect,
  HashMap,
  Layer,
  Option,
  Ref,
  pipe,
} from "effect"
import { Settings } from "./settings.ts"
import type { SettingsInterface } from "./settings.ts"

/** What to do with a denial after counting it. */
type BreakerDecision = Data.TaggedEnum<{
  /** Return the denial to the agent so it can find a safer path. */
  Deny: { readonly consecutive: number; readonly total: number }
  /** Too many denials this turn: hand the decision to the user. */
  Escalate: { readonly consecutive: number; readonly total: number }
}>

const BreakerDecision = Data.taggedEnum<BreakerDecision>()

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
  readonly recordDenial: (turn: ReviewTurn) => Effect.Effect<BreakerDecision>
}

const NO_DENIALS = 0

const ONE_DENIAL = 1

const turnKey = (turn: ReviewTurn): string =>
  JSON.stringify([turn.sessionId, turn.userMessageId])

const countsFor = (
  turns: HashMap.HashMap<string, TurnDenials>,
  key: string,
): TurnDenials =>
  pipe(
    HashMap.get(turns, key),
    Option.getOrElse(() => ({
      consecutive: NO_DENIALS,
      total: NO_DENIALS,
    })),
  )

type Turns = HashMap.HashMap<string, TurnDenials>

const countDenial =
  (settings: SettingsInterface, key: string) =>
  (
    current: HashMap.HashMap<string, TurnDenials>,
  ): readonly [BreakerDecision, Turns] => {
    const counts = countsFor(current, key)
    const consecutive = counts.consecutive + ONE_DENIAL
    const total = counts.total + ONE_DENIAL
    const next = HashMap.set(current, key, { consecutive, total })

    if (
      consecutive >= settings.maxConsecutiveDenials ||
      total >= settings.maxTotalDenials
    ) {
      return [BreakerDecision.Escalate({ consecutive, total }), next]
    }

    return [BreakerDecision.Deny({ consecutive, total }), next]
  }

/** Shares denial counts across a root session and its subagents. */
class DenialBreaker extends Context.Service<DenialBreaker, Interface>()(
  "opencode-auto-review/DenialBreaker",
) {
  public static readonly layer = Layer.effect(
    DenialBreaker,
    Effect.gen(function* makeDenialBreaker() {
      const settings = yield* Settings
      const turns = yield* Ref.make(HashMap.empty<string, TurnDenials>())

      const recordApproval = Effect.fn("DenialBreaker.recordApproval")(
        function* recordApproval(turn: ReviewTurn) {
          const key = turnKey(turn)

          yield* Ref.update(turns, (current) =>
            HashMap.set(current, key, {
              consecutive: NO_DENIALS,
              total: countsFor(current, key).total,
            }),
          )
        },
      )

      const recordDenial = Effect.fn("DenialBreaker.recordDenial")(
        function* recordDenial(turn: ReviewTurn) {
          return yield* Ref.modify(turns, countDenial(settings, turnKey(turn)))
        },
      )

      return DenialBreaker.of({ recordApproval, recordDenial })
    }),
  )
}

export { BreakerDecision, DenialBreaker }

export type { ReviewTurn }
