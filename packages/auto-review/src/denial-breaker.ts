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
  /** The user message that started the turn being counted. */
  readonly turn: string
}

interface Interface {
  /** Counts an approval, which ends a run of consecutive denials. */
  readonly recordApproval: (
    sessionId: string,
    turn: string,
  ) => Effect.Effect<void>
  /** Counts a denial and decides whether the agent or the user gets it. */
  readonly recordDenial: (
    sessionId: string,
    turn: string,
  ) => Effect.Effect<BreakerDecision>
}

const NO_DENIALS = 0

const ONE_DENIAL = 1

/**
 * Reads a session's counts for a turn; a new turn starts from zero.
 * @param {HashMap.HashMap<string, TurnDenials>} sessions Counts by session.
 * @param {string} sessionId The session.
 * @param {string} turn The current turn.
 * @returns {TurnDenials} The counts.
 */
const countsFor = (
  sessions: HashMap.HashMap<string, TurnDenials>,
  sessionId: string,
  turn: string,
): TurnDenials =>
  pipe(
    HashMap.get(sessions, sessionId),
    Option.filter((counts) => counts.turn === turn),
    Option.getOrElse(() => ({
      consecutive: NO_DENIALS,
      total: NO_DENIALS,
      turn,
    })),
  )

type Sessions = HashMap.HashMap<string, TurnDenials>

/**
 * Builds the state transition for one denial.
 * @param {SettingsInterface} settings The configured denial limits.
 * @param {string} sessionId The session.
 * @param {string} turn The current turn.
 * @returns {Function} Maps the counts to a decision and the new counts.
 */
const countDenial =
  (settings: SettingsInterface, sessionId: string, turn: string) =>
  (
    current: HashMap.HashMap<string, TurnDenials>,
  ): readonly [BreakerDecision, Sessions] => {
    const counts = countsFor(current, sessionId, turn)
    const consecutive = counts.consecutive + ONE_DENIAL
    const total = counts.total + ONE_DENIAL

    if (
      consecutive >= settings.maxConsecutiveDenials ||
      total >= settings.maxTotalDenials
    ) {
      const reset = { consecutive: NO_DENIALS, total: NO_DENIALS, turn }

      return [
        BreakerDecision.Escalate({ consecutive, total }),
        HashMap.set(current, sessionId, reset),
      ]
    }

    return [
      BreakerDecision.Deny({ consecutive, total }),
      HashMap.set(current, sessionId, { consecutive, total, turn }),
    ]
  }

/**
 * Tracks review denials per session and turn, and stops a session that keeps
 * pushing against denials by asking the user instead, as Codex does.
 */
class DenialBreaker extends Context.Service<DenialBreaker, Interface>()(
  "opencode-auto-review/DenialBreaker",
) {
  public static readonly layer = Layer.effect(
    DenialBreaker,
    Effect.gen(function* makeDenialBreaker() {
      const settings = yield* Settings
      const sessions = yield* Ref.make(HashMap.empty<string, TurnDenials>())

      const recordApproval = (
        sessionId: string,
        turn: string,
      ): Effect.Effect<void> =>
        Ref.update(sessions, (current) =>
          HashMap.set(current, sessionId, {
            consecutive: NO_DENIALS,
            total: countsFor(current, sessionId, turn).total,
            turn,
          }),
        )

      const recordDenial = (
        sessionId: string,
        turn: string,
      ): Effect.Effect<BreakerDecision> =>
        Ref.modify(sessions, countDenial(settings, sessionId, turn))

      return DenialBreaker.of({ recordApproval, recordDenial })
    }),
  )
}

export { BreakerDecision, DenialBreaker }
