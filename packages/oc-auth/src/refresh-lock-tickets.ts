import { Array as Arr, BigInt as Big, Option } from "effect"
import LockAttempt from "./refresh-lock-attempt.ts"
import type RefreshLockClaim from "./refresh-lock-claim.ts"

type Attempt = ReturnType<(typeof LockAttempt)["busy" | "cooldown" | "held"]>

type Claim = typeof RefreshLockClaim.Type

const DIGITS = /^\d+$/u,
  LOCK_SUFFIX = ".lock",
  NO_CLAIMS = 0,
  /* What the live claims among `claims` say, or none when there are none. */
  contention = (
    claims: readonly Claim[],
    now: number,
  ): Option.Option<Attempt> => {
    const live = claims.filter((claim) => claim.expiresAt >= now),
      until = Math.max(...live.map((claim) => claim.expiresAt))

    if (live.length === NO_CLAIMS) {
      return Option.none()
    }

    if (!live.every((claim) => claim.cooldown)) {
      return Option.some(LockAttempt.busy())
    }

    return Option.some(LockAttempt.cooldown({ until }))
  },
  /* The highest ticket among `claims`, or `floor` when that is higher. */
  highestTicket = (claims: readonly Claim[], floor: bigint): bigint =>
    Arr.reduce(claims, floor, (highest, claim) =>
      Big.max(highest, claim.ticket),
    ),
  /* Another process committed a later ticket, or holds a live earlier one. */
  superseded = (
    claims: readonly Claim[],
    ticket: bigint,
    now: number,
  ): boolean =>
    claims.some(
      (claim) =>
        claim.ticket > ticket ||
        (claim.ticket !== ticket && claim.expiresAt >= now),
    ),
  /* The file name of `ticket` under `prefix`. */
  ticketName = (prefix: string, ticket: bigint): string =>
    `${prefix}${ticket}${LOCK_SUFFIX}`,
  /* The ticket a file named `name` holds, or none when it is not a ticket of `prefix`. */
  ticketOf = (name: string, prefix: string): Option.Option<bigint> => {
    if (!name.startsWith(prefix) || !name.endsWith(LOCK_SUFFIX)) {
      return Option.none()
    }

    const raw = name.slice(prefix.length, -LOCK_SUFFIX.length)

    if (!DIGITS.test(raw)) {
      return Option.none()
    }

    return Option.some(BigInt(raw))
  }

/** The ticket arithmetic of the refresh lock, free of I/O. */
export default Object.freeze({
  contention,
  highestTicket,
  superseded,
  ticketName,
  ticketOf,
})
