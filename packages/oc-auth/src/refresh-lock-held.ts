import { Clock, Effect, Exit, Option, Ref, Scope } from "effect"
import type { FileSystem, Path } from "effect"
import type Environment from "./environment.ts"
import LockAttempt from "./refresh-lock-attempt.ts"
import type RefreshLockClaim from "./refresh-lock-claim.ts"
import leases from "./refresh-lock-lease.ts"
import pluginLog from "./plugin-log.ts"
import ticketFiles from "./refresh-lock-ticket-files.ts"
import tickets from "./refresh-lock-tickets.ts"

/** A ticket this process has just created, open for lease writes. */
interface Ticket {
  readonly dir: string
  readonly file: FileSystem.File
  /** The path-free name of the store in warnings. */
  readonly lock: string
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

/* This process's lease is still the one on disk and has not expired. */
const checkLease = Effect.fn("RefreshLock.checkLease")(function* checkLease(
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
  /* Log that `held` no longer belongs to this process. */
  lost = (held: Ticket): Effect.Effect<void> =>
    pluginLog.debug("refresh_lock_lost", {
      source: held.source,
      ticket: held.ticket.toString(),
    }),
  /*
   * Lease `held` for `ms` as a cooldown claim, if it is still ours. Reviving
   * a lease this process no longer holds would republish a claim a successor
   * has moved past. Only a written lease makes a cooldown claim: after a
   * failed write, release expires the lease as usual.
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

    if (!(yield* leases.write(held, "cooldown", ms))) {
      return
    }

    yield* Ref.set(deferred, true)
    yield* pluginLog.debug("refresh_lock_deferred", { ms, source: held.source })
  }),
  /* Lease `held` for `ms` from now, if it is still ours and the lease is written. */
  prolong = Effect.fn("RefreshLock.extend")(function* prolong(
    held: Ticket,
    ms: number,
  ) {
    if (!(yield* confirmOwnership(held))) {
      return yield* lost(held).pipe(Effect.as(false))
    }

    if (!(yield* leases.write(held, "extension", ms))) {
      return false
    }

    // This process just wrote the lease, so only the order needs a new look.
    if (!(yield* checkOrder(held))) {
      return yield* lost(held).pipe(Effect.as(false))
    }

    yield* pluginLog.debug("refresh_lock_extended", { ms, source: held.source })

    return true
  }),
  /* Expire the lease on `held` and close its ticket. */
  quit = (held: Ticket): Effect.Effect<void, never, Environment> =>
    leases
      .expire(held)
      .pipe(Effect.andThen(Scope.close(held.scope, Exit.void))),
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
  /* Withdraw the claim on `held` and report the lock busy. */
  stepAside = (
    held: Ticket,
  ): Effect.Effect<ReturnType<typeof LockAttempt.Busy>, never, Environment> =>
    quit(held).pipe(Effect.as(LockAttempt.Busy())),
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
  }),
  /*
   * Scan again now the first lease on `held` is published, and hand back the
   * lock, or withdraw and report busy when another process committed
   * meanwhile.
   *
   * A higher ticket proves another process committed after this caller's first
   * scan; a live lower one means a delayed process recreated a ticket a sweep
   * removed. Either makes this claim withdraw before the refresh goes on. A
   * failed scan skips the sweep rather than sweep from the earlier scan.
   */
  win = Effect.fn("RefreshLock.win")(function* win(held: Ticket) {
    const fresh = yield* ticketFiles
        .scan(held.dir, held.prefix, held.ttlMs)
        .pipe(
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
        ),
      now = yield* Clock.currentTimeMillis

    if (
      Option.exists(fresh, (claims: Claims) =>
        tickets.superseded(claims, held.ticket, now),
      )
    ) {
      return yield* stepAside(held)
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

/*
 * Publish the first lease on a freshly created ticket and hand back the lock.
 * A ticket whose first lease could not be written is no claim other processes
 * can rely on, so it is withdrawn and the lock reported busy: the caller waits
 * for another process's result, as when the lock is lost, rather than refresh
 * under a claim nobody may see.
 */
export default Effect.fn("RefreshLock.commit")(function* commit(held: Ticket) {
  if (!(yield* leases.write(held, "initial", held.ttlMs))) {
    return yield* stepAside(held)
  }

  return yield* win(held)
})
