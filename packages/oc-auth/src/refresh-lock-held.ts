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
  START = 0n,
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
  /* No other process has committed a later ticket; false when the scan fails. */
  checkOrder = (held: Ticket): Effect.Effect<boolean, never, Requirements> =>
    ticketFiles.scan(held.dir, held.prefix, held.ttlMs).pipe(
      Effect.flatMap((claims: Claims) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => !tickets.superseded(claims, held.ticket, now)),
        ),
      ),
      Effect.orElseSucceed(() => false),
    ),
  /* The lease on disk is still ours and live, and no other process has moved past it. */
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
      }).pipe(Effect.orDie),
      payloadBytes = encoder.encode(payload.padEnd(LEASE_BYTES, " "))

    /*
     * A failed write leaves the previous lease in force, and a scan reads a
     * fresh ticket, which has no lease yet, by its mtime.
     */
    yield* held.file.seek(START, "start").pipe(
      Effect.andThen(held.file.writeAll(payloadBytes)),
      Effect.catchTag(
        "PlatformError",
        (failure: { readonly message: string }) =>
          pluginLog.debug("refresh_lock_error", {
            error: failure.message,
            source: held.source,
          }),
      ),
    )
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
  /*
   * Lease `held` for `ms` as a cooldown claim, if it is still ours. Reviving
   * a lease this process no longer holds would republish a claim a successor
   * has moved past.
   */
  postpone = Effect.fn("RefreshLock.defer")(function* postpone(
    held: Ticket,
    deferred: Ref.Ref<boolean>,
    ms: number,
  ) {
    if (!(yield* confirmOwnership(held))) {
      yield* lost(held)

      return
    }

    yield* Ref.set(deferred, true)
    yield* lease(held, ms, true)
    yield* pluginLog.debug("refresh_lock_deferred", { ms, source: held.source })
  }),
  /* Lease `held` for `ms` from now, if it is still ours. */
  prolong = Effect.fn("RefreshLock.extend")(function* prolong(
    held: Ticket,
    ms: number,
  ) {
    if (!(yield* confirmOwnership(held))) {
      return yield* lost(held).pipe(Effect.as(false))
    }

    yield* lease(held, ms, false)

    // This process just wrote the lease, so only the order needs a new look.
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
  /* Close the ticket of `held` once, expiring its lease unless it was deferred. */
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
   * Remove the expired tombstones `settled` lists. The ticket `held` now keeps
   * the numbering monotonic, so no ticket number becomes reusable. Only the
   * scan taken after the commit will do: an earlier one can show a claim as
   * expired that its holder has since revived, and removing that file would
   * leave the holder leasing a ticket no scan finds.
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

    return LockAttempt.Held({
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
 * A higher ticket proves another process committed after this caller's first
 * scan; a live lower one means a delayed process recreated a ticket a sweep
 * removed. Either makes this claim withdraw before the refresh goes on. A
 * failed scan skips the sweep rather than sweep from the earlier scan.
 */
export default Effect.fn("RefreshLock.commit")(function* commit(held: Ticket) {
  const fresh = yield* publish(held),
    now = yield* Clock.currentTimeMillis

  if (
    Option.exists(fresh, (claims: Claims) =>
      tickets.superseded(claims, held.ticket, now),
    )
  ) {
    return yield* quit(held).pipe(Effect.as(LockAttempt.Busy()))
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
