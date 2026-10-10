import { Clock, Effect, Exit, Option, Ref, Schema, Scope } from "effect"
import type { FileSystem, Path } from "effect"
import Environment from "./environment.ts"
import LockAttempt from "./refresh-lock-attempt.ts"
import type RefreshLockClaim from "./refresh-lock-claim.ts"
import pluginLog from "./plugin-log.ts"
import ticketFiles from "./refresh-lock-ticket-files.ts"
import tickets from "./refresh-lock-tickets.ts"

/** A ticket this process has just created, open for lease writes. */
interface Ticket {
  readonly dir: string
  readonly file: FileSystem.File
  readonly owner: string
  readonly path: string
  readonly prefix: string
  /** Owns `file`; closing it closes the ticket. */
  readonly scope: Scope.Closeable
  readonly source: string
  readonly ticket: bigint
  readonly ttlMs: number
}

type Claims = readonly (typeof RefreshLockClaim.Type)[]

type Requirements = Environment | FileSystem.FileSystem | Path.Path

/*
 * Fixed payload width. A lease is rewritten in place, so a constant length
 * keeps a concurrent reader from observing a truncated or half-overwritten
 * claim and falling back to the mtime heuristic. JSON parsing ignores the pad.
 */
const LEASE_BYTES = 256,
  /** The lease a ticket carries, as JSON in this field order. */
  LeaseRecord = Schema.fromJsonString(
    Schema.Struct({
      cooldown: Schema.Boolean,
      expiresAt: Schema.Finite,
      owner: Schema.String,
      pid: Schema.Finite,
    }),
  ),
  RELEASED = 0,
  START = 0,
  /* This process's lease is still the one on disk and has not expired. */
  checkLease = Effect.fn("RefreshLock.checkLease")(function* checkLease(
    held: Ticket,
  ) {
    const lease = yield* ticketFiles.readLease(held.path),
      now = yield* Clock.currentTimeMillis

    return Option.exists(
      lease,
      (value: { readonly expiresAt: number; readonly owner?: string }) =>
        value.owner === held.owner && value.expiresAt > now,
    )
  }),
  /* No other process has committed a later ticket. */
  checkOrder = (held: Ticket): Effect.Effect<boolean, never, Requirements> =>
    ticketFiles.scan(held.dir, held.prefix, held.ttlMs).pipe(
      Effect.flatMap((claims: Claims) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => !tickets.superseded(claims, held.ticket, now)),
        ),
      ),
      Effect.orElseSucceed(() => false),
    ),
  /* Both: the lease on disk is ours and live, and nobody has moved past it. */
  confirmOwnership = Effect.fn("RefreshLock.confirmOwnership")(
    function* confirmOwnership(held: Ticket) {
      if (!(yield* checkLease(held))) {
        return false
      }

      return yield* checkOrder(held)
    },
  ),
  encoder = new TextEncoder(),
  /* Rewrite the lease on `held` in place to end at `expiresAt`. */
  inscribe = Effect.fn("RefreshLock.writeLease")(function* inscribe(
    held: Ticket,
    expiresAt: number,
    cooldown: boolean,
  ) {
    const environment = yield* Environment,
      // The fields are plain values, so encoding them cannot fail.
      payload = yield* Schema.encodeEffect(LeaseRecord)({
        cooldown,
        expiresAt,
        owner: held.owner,
        pid: environment.process.pid,
      }).pipe(Effect.orDie)

    yield* held.file.seek(START, "start")
    // A concurrent scan treats the fresh claim mtime as a live lease.
    yield* held.file
      .writeAll(encoder.encode(payload.padEnd(LEASE_BYTES, " ")))
      .pipe(Effect.ignore)
  }),
  /* Lease `held` for `ms` from now. */
  lease = (
    held: Ticket,
    ms: number,
    cooldown: boolean,
  ): Effect.Effect<void, never, Environment> =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => inscribe(held, now + ms, cooldown)),
    ),
  /* Log that `held` no longer belongs to this process. */
  lost = (held: Ticket): Effect.Effect<void> =>
    pluginLog.debug("refresh_lock_lost", {
      source: held.source,
      ticket: held.ticket.toString(),
    }),
  postpone = Effect.fn("RefreshLock.defer")(function* postpone(
    held: Ticket,
    deferred: Ref.Ref<boolean>,
    ms: number,
  ) {
    /*
     * Same ownership check extend() makes: reviving a lease this process no
     * longer holds would republish a claim a successor has moved past.
     */
    if (!(yield* confirmOwnership(held))) {
      yield* lost(held)

      return
    }

    yield* Ref.set(deferred, true)
    yield* lease(held, ms, true)
    yield* pluginLog.debug("refresh_lock_deferred", { ms, source: held.source })
  }),
  prolong = Effect.fn("RefreshLock.extend")(function* prolong(
    held: Ticket,
    ms: number,
  ) {
    if (!(yield* confirmOwnership(held))) {
      return yield* lost(held).pipe(Effect.as(false))
    }

    yield* lease(held, ms, false)

    /*
     * Only the supersession half needs re-checking: the lease was just
     * written by this process, and re-reading it back is the single most
     * expensive syscall on the refresh path.
     */
    if (!(yield* checkOrder(held))) {
      return yield* lost(held).pipe(Effect.as(false))
    }

    yield* pluginLog.debug("refresh_lock_extended", { ms, source: held.source })

    return true
  }),
  /* Publish the first lease on `held`, then scan again; none when the scan fails. */
  publish = Effect.fn("RefreshLock.publish")(function* publish(held: Ticket) {
    yield* lease(held, held.ttlMs, false)

    return yield* ticketFiles.scan(held.dir, held.prefix, held.ttlMs).pipe(
      Effect.map((claims: Claims) => Option.some(claims)),
      Effect.catchTag(
        "PlatformError",
        (failure: { readonly message: string }) =>
          pluginLog
            .debug("refresh_lock_error", {
              error: failure.message,
              source: held.source,
            })
            .pipe(Effect.as(Option.none())),
      ),
    )
  }),
  /* Expire the lease on `held` and close its ticket. */
  quit = (held: Ticket): Effect.Effect<void, never, Environment> =>
    inscribe(held, RELEASED, false).pipe(
      Effect.andThen(Scope.close(held.scope, Exit.void)),
    ),
  release = Effect.fn("RefreshLock.release")(function* release(
    held: Ticket,
    flags: {
      readonly deferred: Ref.Ref<boolean>
      readonly released: Ref.Ref<boolean>
    },
  ) {
    const deferred = yield* Ref.get(flags.deferred)

    if (yield* Ref.getAndSet(flags.released, true)) {
      return
    }

    // A deferred lease is a cooldown claim, which must outlive the holder.
    if (deferred) {
      yield* Scope.close(held.scope, Exit.void)

      return
    }

    yield* quit(held)
  }),
  /*
   * The successor ticket now preserves monotonic ordering, so older expired
   * tombstones can be removed without making any ticket reusable. This reads
   * the post-commit scan: the pre-commit one can show a claim as expired that
   * its holder has since revived, and unlinking that file strands the holder.
   */
  sweep = (
    held: Ticket,
    settled: Claims,
    now: number,
  ): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.forEach(
      settled.filter(
        (claim) => claim.ticket !== held.ticket && claim.expiresAt < now,
      ),
      (claim) => ticketFiles.removeTicket(claim.path),
      { discard: true },
    ),
  /* The held lock on `held`, its methods bound to the current services. */
  toLock = Effect.fn("RefreshLock.toLock")(function* toLock(held: Ticket) {
    const context = yield* Effect.context<Requirements>(),
      deferred = yield* Ref.make(false),
      released = yield* Ref.make(false)

    return LockAttempt.held({
      lock: {
        defer: (ms) =>
          postpone(held, deferred, ms).pipe(Effect.provideContext(context)),
        degraded: false,
        extend: (ms) => prolong(held, ms).pipe(Effect.provideContext(context)),
        release: release(held, { deferred, released }).pipe(
          Effect.provideContext(context),
        ),
      },
    })
  })

/*
 * Publish the lease on a freshly created ticket and hand back the lock, or
 * withdraw and report busy when another process committed meanwhile.
 *
 * A delayed contender may recreate a compacted lower ticket. A higher ticket
 * proves another process committed after this caller's first scan, so this
 * claim must withdraw before returning to the refresh path. The sweep acts
 * only on the post-commit scan, so a failed scan skips the sweep instead of
 * falling back to stale information.
 */
export default Effect.fn("RefreshLock.commit")(function* commit(held: Ticket) {
  const fresh = yield* publish(held),
    now = yield* Clock.currentTimeMillis

  if (
    Option.exists(fresh, (claims: Claims) =>
      tickets.superseded(claims, held.ticket, now),
    )
  ) {
    return yield* quit(held).pipe(Effect.as(LockAttempt.busy()))
  }

  yield* sweep(
    held,
    Option.getOrElse(fresh, () => []),
    now,
  )
  yield* pluginLog.debug("refresh_lock_acquired", {
    source: held.source,
    ticket: held.ticket.toString(),
  })

  return yield* toLock(held)
})
