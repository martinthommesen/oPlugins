import {
  Array as Arr,
  Clock,
  Effect,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Schema,
} from "effect"
import type RefreshLockClaim from "./refresh-lock-claim.ts"
import pluginLog from "./plugin-log.ts"
import tickets from "./refresh-lock-tickets.ts"

type Claim = typeof RefreshLockClaim.Type

/** What a ticket says about its claim, before it is tied to its file. */
interface Expiry {
  readonly cooldown: boolean
  readonly expiresAt: number
}

/*
 * How long a ticket's claim lasts when its file can't tell, from when the
 * file last changed:
 *
 * - An empty ticket has just been created, and its creator writes the first
 *   lease right away, so it lasts the reader's own lease length.
 * - A ticket that can't be read, or holds no lease oc-auth could have
 *   written, lasts the longest lease oc-auth writes. That covers a partly
 *   written lease, and one ending further off than the longest lease from
 *   now. Every lease is capped at the longest, so the claim never ends sooner
 *   than the lease the ticket can hold, whatever options the process that
 *   wrote it has, and a ticket that stays unreadable stops blocking refreshes
 *   once that time has passed.
 *
 * A ticket that can't be examined, for a reason other than being gone, fails
 * the scan rather than count as absent: a caller seeking the lock takes the
 * degraded lock and warns, and a holder counts the lock lost.
 */

// The lease in a ticket file, as JSON; without `cooldown` it holds a refresh.
const Lease = Schema.fromJsonString(
    Schema.Struct({
      cooldown: Schema.optionalKey(Schema.Boolean),
      expiresAt: Schema.Finite,
      owner: Schema.optionalKey(Schema.String),
    }),
  ),
  NEW_TICKET_LENGTH = 0,
  /** Why a ticket without a modification time can't be examined. */
  UNDATED = PlatformError.badArgument({
    description: "the ticket has no modification time",
    method: "stat",
    module: "FileSystem",
  }),
  /*
   * When the ticket at `path` stops being live: `ms` after it was last
   * modified. None when it is gone; fails when it can't be examined.
   */
  changedPlus = Effect.fn("RefreshLock.changedPlus")(function* changedPlus(
    path: string,
    ms: number,
  ) {
    const fs = yield* FileSystem.FileSystem

    return yield* fs.stat(path).pipe(
      Effect.flatMap((info: { readonly mtime: Option.Option<Date> }) => {
        if (Option.isNone(info.mtime)) {
          return Effect.fail(UNDATED)
        }

        return Effect.succeedSome<Expiry>({
          cooldown: false,
          expiresAt: info.mtime.value.getTime() + ms,
        })
      }),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    )
  }),
  /*
   * The claim of a ticket at `path` that can't tell its own, because
   * reading it failed with `error`: live for the longest lease.
   */
  conservative = (
    path: string,
    error: string,
  ): Effect.Effect<
    Option.Option<Expiry>,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > =>
    pluginLog
      .debug("refresh_lock_ticket_unreadable", { error, path })
      .pipe(Effect.andThen(changedPlus(path, tickets.MAX_LEASE_MS))),
  /*
   * The claim of the ticket at `path`, which holds `text`. A lease ending
   * further off than the longest lease is not one oc-auth wrote.
   */
  fromText = Effect.fn("RefreshLock.fromText")(function* fromText(
    path: string,
    text: string,
    ttlMs: number,
  ) {
    const lease = Schema.decodeOption(Lease)(text),
      now = yield* Clock.currentTimeMillis

    if (text.length === NEW_TICKET_LENGTH) {
      return yield* changedPlus(path, ttlMs)
    }

    return yield* Option.match(
      lease.pipe(
        Option.filter(
          (value: { readonly expiresAt: number }) =>
            value.expiresAt <= now + tickets.MAX_LEASE_MS,
        ),
      ),
      {
        onNone: () => conservative(path, "no lease oc-auth could have written"),
        onSome: (value) =>
          Effect.succeedSome<Expiry>({
            cooldown: value.cooldown === true,
            expiresAt: value.expiresAt,
          }),
      },
    )
  }),
  /* The lease written in the ticket at `path`, or none when it has none or cannot be read. */
  leaseAt = Effect.fn("RefreshLock.readLease")(function* leaseAt(path: string) {
    const fs = yield* FileSystem.FileSystem

    return yield* fs.readFileString(path).pipe(
      Effect.map((text) => Schema.decodeOption(Lease)(text)),
      Effect.orElseSucceed(() => Option.none<typeof Lease.Type>()),
    )
  }),
  /* The claim the ticket at `path` makes, or none when it is gone. Fails when it can't be examined. */
  readClaim = Effect.fn("RefreshLock.readClaim")(function* readClaim(
    path: string,
    ticket: bigint,
    ttlMs: number,
  ) {
    const fs = yield* FileSystem.FileSystem,
      lease = yield* fs.readFileString(path).pipe(
        Effect.map((text) => fromText(path, text, ttlMs)),
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed(Effect.succeedNone),
        ),
        Effect.catchTag(
          "PlatformError",
          (failure: { readonly message: string }) =>
            Effect.succeed(conservative(path, failure.message)),
        ),
        Effect.flatten,
      )

    return lease.pipe(
      Option.map((found): Claim => ({
        cooldown: found.cooldown,
        expiresAt: found.expiresAt,
        path,
        ticket,
      })),
    )
  }),
  /* The claim the file `name` in `dir` makes, or none when it is no ticket of `prefix`. */
  readNamed = Effect.fn("RefreshLock.readNamed")(function* readNamed(
    dir: string,
    name: string,
    of: { readonly prefix: string; readonly ttlMs: number },
  ) {
    const path = yield* Path.Path

    return yield* Option.match(tickets.ticketOf(name, of.prefix), {
      onNone: () => Effect.succeedNone,
      onSome: (ticket) => readClaim(path.join(dir, name), ticket, of.ttlMs),
    })
  }),
  /* Remove the ticket at `path`, if it is still there. */
  removeTicket = Effect.fn("RefreshLock.removeTicket")(function* removeTicket(
    path: string,
  ) {
    const fs = yield* FileSystem.FileSystem

    // The claim may already have been removed by another successor.
    yield* fs.remove(path).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
      Effect.catchTag(
        "PlatformError",
        (failure: { readonly message: string }) =>
          pluginLog.debug("refresh_lock_sweep_failed", {
            error: failure.message,
            path,
          }),
      ),
    )
  }),
  /* Every claim on the tickets of `prefix` in `dir`. Fails when `dir`, or a ticket in it, can't be examined. */
  scan = Effect.fn("RefreshLock.scan")(function* scan(
    dir: string,
    prefix: string,
    ttlMs: number,
  ) {
    const fs = yield* FileSystem.FileSystem

    return yield* fs.readDirectory(dir).pipe(
      Effect.flatMap(
        Effect.forEach((name: string) =>
          readNamed(dir, name, { prefix, ttlMs }),
        ),
      ),
      Effect.map((claims: readonly Option.Option<Claim>[]) =>
        Arr.getSomes(claims),
      ),
    )
  })

/** Reading, scanning, and removing ticket files. */
export default Object.freeze({ readLease: leaseAt, removeTicket, scan })
