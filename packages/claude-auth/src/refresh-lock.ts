/**
 * Best-effort cross-process single flight for rotating OAuth refresh tokens.
 *
 * Lock files are monotonically numbered source-local tickets. Creating the next
 * ticket with O_EXCL is where processes contend, but it does not settle the
 * winner on its own. A post-create supersession check can still withdraw the
 * claim. Released tickets stay as expired tombstones until a successor exists,
 * so ticket numbers never reset and a stale holder can never target its
 * successor's path.
 *
 * Coordination is best-effort, not guaranteed. When the lock directory is
 * unusable the service degrades to a lock that serializes nothing, because
 * refusing to refresh would be the worse failure. That degradation is reported
 * as a `refresh_lock_degraded` warning and marked on the lock so callers and
 * tests can tell it apart from a real acquisition.
 */
import {
  Clock,
  Context,
  Crypto,
  Effect,
  Encoding,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Scope,
} from "effect"
import DebugLog from "./debug-log.ts"
import Environment from "./environment.ts"
import LockAttempt from "./refresh-lock-attempt.ts"
import type { PlatformError } from "effect"
import type RefreshLockClaim from "./refresh-lock-claim.ts"
import commit from "./refresh-lock-held.ts"
import opencodeDataDir from "./opencode-data-dir.ts"
import ticketFiles from "./refresh-lock-ticket-files.ts"
import tickets from "./refresh-lock-tickets.ts"

type Attempt = ReturnType<(typeof LockAttempt)["busy" | "cooldown" | "held"]>

type Claims = readonly (typeof RefreshLockClaim.Type)[]

/** Where and for whom one acquisition takes tickets. */
interface Plan {
  readonly dir: string
  readonly owner: string
  readonly prefix: string
  readonly source: string
  readonly ttlMs: number
}

type Ticket = typeof commit extends (ticket: infer Held) => object
  ? Held
  : never

type Requirements = DebugLog | Environment | FileSystem.FileSystem | Path.Path

/*
 * The lock granted when the lock directory cannot be used. `extend` reports
 * success because failing every refresh on a machine with an unwritable lock
 * directory would be worse than an uncoordinated refresh.
 */
const DEGRADED_LOCK = {
    defer: (): Effect.Effect<void> => Effect.void,
    degraded: true,
    extend: (): Effect.Effect<boolean> => Effect.succeed(true),
    release: Effect.void,
  },
  // Ceiling for a lease, so a mistyped TTL cannot block refreshes for days.
  MAX_LOCK_TTL_MS = 120_000,
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
  /* Grant the uncoordinated lock, and tell the user. */
  degrade = Effect.fn("RefreshLock.degrade")(function* degrade(
    source: string,
    failure: { readonly message: string },
  ) {
    const debugLog = yield* DebugLog

    yield* debugLog.warn("refresh_lock_degraded", {
      source,
      warning: `token refreshes are not coordinated between OpenCode processes (${failure.message}); two refreshing at once can sign Claude Code out. Check that the lock directory is writable.`,
    })

    return LockAttempt.held({ lock: DEGRADED_LOCK })
  }),
  encoder = new TextEncoder(),
  /* `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR`, else OpenCode's data directory. */
  lockDir = Effect.gen(function* resolveLockDir() {
    const environment = yield* Environment

    return yield* Option.match(environment.variables.lockDir, {
      onNone: () => opencodeDataDir,
      onSome: (dir) => Effect.succeed(dir),
    })
  }),
  /*
   * The file name prefix of the tickets of `source`. It keeps the plugin's
   * former name, so processes still running an older build share the lock.
   */
  lockPrefix = Effect.fn("RefreshLock.lockPrefix")(function* lockPrefix(
    source: string,
  ) {
    const crypto = yield* Crypto.Crypto,
      digest = yield* crypto.digest("SHA-256", encoder.encode(source))

    return `claude-auth-refresh-${Encoding.encodeHex(digest).slice(START, PREFIX_HEX_LENGTH)}-`
  }),
  /*
   * Take the ticket after the highest of the live tickets and `floor`, or
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
  /* One acquisition of the lock for `source` in `dir`. */
  seekLock = Effect.fn("RefreshLock.seekLock")(function* seekLock(
    dir: string,
    source: string,
    ttlMs: number,
  ) {
    const crypto = yield* Crypto.Crypto,
      fs = yield* FileSystem.FileSystem,
      owner = yield* crypto.randomUUIDv4,
      prefix = yield* lockPrefix(source)

    /*
     * Owner-only, because in a shared lock directory any local user could
     * hold a long-lived claim and stall every refresh. A failure is left to
     * the scan, which determines whether coordination is available.
     */
    yield* fs
      .makeDirectory(dir, { mode: PRIVATE_DIRECTORY, recursive: true })
      .pipe(Effect.ignore)

    return yield* race({ dir, owner, prefix, source, ttlMs }, NO_TICKET)
  }),
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
      seekLock(dir, source, ttlMs).pipe(
        Effect.catchTag(
          "PlatformError",
          (failure: { readonly message: string }) => degrade(source, failure),
        ),
      ),
      LockAttempt.$match({
        Busy: () => Effect.void,
        Cooldown: () => Effect.void,
        Held: ({ lock }) => lock.release,
      }),
    )

/**
 * The cross-process refresh lock. `acquire` takes the lock for one
 * credential source, in `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR` or
 * OpenCode's data directory, leased for
 * `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_TTL_MS` up to `maxTtlMs`. A held lock is
 * released when the caller's scope closes, if not before.
 */
class RefreshLock extends Context.Service<
  RefreshLock,
  {
    readonly acquire: (
      source: string,
    ) => Effect.Effect<Attempt, never, Scope.Scope>
  }
>()("oclaude/RefreshLock") {
  /** The live lock. */
  public static readonly layer: Layer.Layer<
    RefreshLock,
    never,
    Crypto.Crypto | Requirements
  > = Layer.effect(
    RefreshLock,
    Effect.gen(function* makeRefreshLock() {
      const context = yield* Effect.context<Crypto.Crypto | Requirements>(),
        dir = yield* lockDir,
        environment = yield* Environment,
        ttlMs = Math.min(MAX_LOCK_TTL_MS, environment.variables.lockTtlMs)

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
