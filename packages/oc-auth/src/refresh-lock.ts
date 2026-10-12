/**
 * Lets one OpenCode process at a time spend a store's refresh token. The
 * token endpoint can rotate the token, so two processes spending it at once
 * can sign Claude Code out.
 *
 * Each lock file is a numbered ticket of one store. Processes contend by
 * creating the next ticket exclusively (`O_EXCL`), but creating it does not
 * win the lock on its own: a scan after the create can still withdraw the
 * claim. A released ticket stays as an expired tombstone until a successor
 * exists, so ticket numbers never reset and a stale holder never writes to
 * its successor's file.
 *
 * When the lock directory, or a ticket in it, can't be examined, every caller
 * gets a lock that serializes nothing, because refusing to refresh would be
 * the worse failure. Each such grant logs a `refresh_lock_degraded` warning,
 * and the lock says it is `degraded`. A ticket that can be examined but not
 * read, or that holds no lease oc-auth could have written, counts as live for
 * the longest lease oc-auth writes after it last changed (see
 * `refresh-lock-ticket-files.ts`).
 *
 * A lease counts only once it is written. When a ticket's lease can't be
 * written, `refresh_lease_unwritten` is logged, and the lock acts as if the
 * claim were lost rather than degrade: other processes may hold tickets in
 * the same directory, and a claim they may never see would let two of them
 * refresh at once. A failed first lease withdraws the ticket and reports the
 * lock busy, a failed extension reports the lock lost, and a failed cooldown
 * lease makes no cooldown claim, so release expires the lease as usual.
 */
import {
  Clock,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Scope,
} from "effect"
import Environment from "./environment.ts"
import { Hex } from "effect/encoding"
import LockAttempt from "./refresh-lock-attempt.ts"
import type { PlatformError } from "effect"
import PluginOptions from "./plugin-options.ts"
import commit from "./refresh-lock-held.ts"
import degrade from "./refresh-lock-degraded.ts"
import opencodeDataDir from "./opencode-data-dir.ts"
import ticketFiles from "./refresh-lock-ticket-files.ts"
import tickets from "./refresh-lock-tickets.ts"

type Attempt = ReturnType<(typeof LockAttempt)["Busy" | "Cooldown" | "Held"]>

type Claims = Effect.Success<ReturnType<typeof ticketFiles.scan>>

/** Where and for whom one acquisition takes tickets. */
interface Plan {
  readonly dir: string
  /** The path-free name of the store in warnings. */
  readonly lock: string
  readonly owner: string
  readonly prefix: string
  readonly source: string
  readonly ttlMs: number
}

/** The lock one acquisition asks for. */
interface Target {
  readonly dir: string
  /** The path-free name of the store in warnings. */
  readonly lock: string
  readonly source: string
  readonly ttlMs: number
}

type Ticket = typeof commit extends (ticket: infer Held) => object
  ? Held
  : never

type Requirements = Environment | FileSystem.FileSystem | Path.Path

const MAX_LOCK_TTL_MS = tickets.MAX_LEASE_MS,
  NEXT_TICKET = 1n,
  NO_TICKET = 0n,
  PREFIX_HEX_LENGTH = 16,
  PRIVATE_DIRECTORY = 0o700,
  START = 0,
  /* What the tickets in the lock directory say: an outcome, or the claims to number past. */
  canvass = Effect.fn("RefreshLock.canvass")(function* canvass(
    plan: Plan,
  ): Effect.fn.Return<
    Result.Result<Attempt, Claims>,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const claims = yield* ticketFiles.scan(plan.dir, plan.prefix, plan.ttlMs),
      now = yield* Clock.currentTimeMillis

    return Option.match(tickets.contention(claims, now), {
      onNone: () => Result.fail(claims),
      onSome: (attempt) => Result.succeed(attempt),
    })
  }),
  /* Create `ticket` exclusively: the open ticket, or `ticket` back when it is taken. */
  createTicket = Effect.fn("RefreshLock.createTicket")(function* createTicket(
    plan: Plan,
    ticket: bigint,
  ): Effect.fn.Return<
    Result.Result<Ticket, bigint>,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      scope = yield* Scope.make(),
      target = path.join(plan.dir, tickets.ticketName(plan.prefix, ticket))

    return yield* fs.open(target, { flag: "wx" }).pipe(
      Scope.provide(scope),
      Effect.map((file) =>
        Result.succeed({
          dir: plan.dir,
          file,
          lock: plan.lock,
          owner: plan.owner,
          path: target,
          prefix: plan.prefix,
          scope,
          source: plan.source,
          ticket,
          ttlMs: plan.ttlMs,
        }),
      ),
      Effect.catchReason("PlatformError", "AlreadyExists", () =>
        Effect.succeed(Result.fail(ticket)),
      ),
    )
  }),
  encoder = new TextEncoder(),
  /* `OC_AUTH_REFRESH_LOCK_DIR`, else OpenCode's data directory. */
  lockDir = Effect.gen(function* resolveLockDir() {
    const environment = yield* Environment

    return yield* Option.match(environment.variables.lockDir, {
      onNone: () => opencodeDataDir,
      onSome: (dir) => Effect.succeed(dir),
    })
  }),
  /*
   * The name of the store `source` keys, as its ticket file names and
   * warnings carry it. A digest stands in for `source`, which can hold a path.
   * A failing digest is a broken platform rather than anything a caller could
   * handle.
   */
  lockName = Effect.fn("RefreshLock.lockName")(function* lockName(
    source: string,
  ) {
    const crypto = yield* Crypto.Crypto,
      digest = yield* crypto.digest("SHA-256", encoder.encode(source))

    return Hex.encode(digest).slice(START, PREFIX_HEX_LENGTH)
  }, Effect.orDie),
  /*
   * Take the ticket after the highest of the expired tickets and `floor`, or
   * report the live claim that turns up while racing for it. Fails when the
   * directory cannot be used.
   */
  race = Effect.fn("RefreshLock.race")(function* nextTicket(
    plan: Plan,
    floor: bigint,
  ): Effect.fn.Return<Attempt, PlatformError.PlatformError, Requirements> {
    const outcome = yield* canvass(plan)

    if (Result.isSuccess(outcome)) {
      return outcome.success
    }

    return yield* createTicket(
      plan,
      tickets.highestTicket(outcome.failure, floor) + NEXT_TICKET,
    ).pipe(
      Effect.flatMap(
        (
          created: Result.Result<Ticket, bigint>,
        ): Effect.Effect<Attempt, PlatformError.PlatformError, Requirements> =>
          Result.match(created, {
            onFailure: (taken) => race(plan, taken),
            onSuccess: (ticket) => commit(ticket),
          }),
      ),
    )
  }),
  /* One acquisition of the lock `target` names. */
  seekLock = Effect.fn("RefreshLock.seekLock")(function* seekLock(
    target: Target,
  ) {
    const crypto = yield* Crypto.Crypto,
      fs = yield* FileSystem.FileSystem,
      owner = yield* crypto.randomUUIDv4

    /*
     * Owner-only, because in a shared lock directory any local user could
     * hold a long-lived claim and stall every refresh. A failure is left to
     * the scan, which determines whether coordination is available.
     */
    yield* fs
      .makeDirectory(target.dir, { mode: PRIVATE_DIRECTORY, recursive: true })
      .pipe(Effect.ignore)

    return yield* race(
      {
        dir: target.dir,
        lock: target.lock,
        owner,
        prefix: `oc-auth-refresh-${target.lock}-`,
        source: target.source,
        ttlMs: target.ttlMs,
      },
      NO_TICKET,
    )
  }),
  /* One acquisition of the lock `target` names, degraded when the lock directory can't be used. */
  seekOrDegrade = (
    target: Target,
  ): Effect.Effect<Attempt, never, Crypto.Crypto | Requirements> =>
    seekLock(target).pipe(
      Effect.catchTag(
        "PlatformError",
        (failure: { readonly message: string }) => degrade(target, failure),
      ),
    ),
  /* Acquire the lock, releasing a held one when the scope closes. */
  takeLock = (
    dir: string,
    source: string,
    ttlMs: number,
  ): Effect.Effect<
    Attempt,
    never,
    Crypto.Crypto | Requirements | Scope.Scope
  > =>
    Effect.acquireRelease(
      lockName(source).pipe(
        Effect.flatMap((lock) => seekOrDegrade({ dir, lock, source, ttlMs })),
      ),
      LockAttempt.$match({
        Busy: () => Effect.void,
        Cooldown: () => Effect.void,
        Held: ({ lock }) => lock.release,
      }),
    )

/**
 * The cross-process refresh lock. `acquire` takes the lock for one store, in
 * `OC_AUTH_REFRESH_LOCK_DIR` or OpenCode's data directory, leased for the
 * `refreshLockTtlMs` option up to `maxTtlMs`. A held lock is released when
 * the caller's scope closes, if not before.
 */
class RefreshLock extends Context.Service<
  RefreshLock,
  {
    readonly acquire: (
      source: string,
    ) => Effect.Effect<Attempt, never, Scope.Scope>
  }
>()("@martinthommesen/oc-auth/refresh-lock/RefreshLock") {
  /** The live lock. */
  public static readonly layer: Layer.Layer<
    RefreshLock,
    never,
    Crypto.Crypto | PluginOptions | Requirements
  > = Layer.effect(
    RefreshLock,
    Effect.gen(function* makeRefreshLock() {
      const context = yield* Effect.context<Crypto.Crypto | Requirements>(),
        dir = yield* lockDir,
        options = yield* PluginOptions,
        ttlMs = Math.min(MAX_LOCK_TTL_MS, options.refreshLockTtlMs)

      return RefreshLock.of({
        acquire: (source) =>
          takeLock(dir, source, ttlMs).pipe(Effect.provideContext(context)),
      })
    }),
  )

  /** Ceiling for a lease, so a mistyped TTL cannot block refreshes for days. */
  public static readonly maxTtlMs = MAX_LOCK_TTL_MS
}

export default RefreshLock
