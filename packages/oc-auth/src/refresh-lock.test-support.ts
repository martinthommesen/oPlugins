import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
} from "effect"
import type { Config, Crypto, PlatformError, Scope, Stdio } from "effect"
import {
  NodeCrypto,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node-shared"
import CapturedStderr from "./captured-stderr.test-support.ts"
import DebugLog from "./debug-log.ts"
import LockAttempt from "./refresh-lock-attempt.ts"
import RefreshLock from "./refresh-lock.ts"
import { TestClock } from "effect/testing"
import testEnvironment from "./test-environment.test-support.ts"

type Attempt = ReturnType<(typeof LockAttempt)["busy" | "cooldown" | "held"]>

type HeldLock = (typeof LockAttempt.held extends (args: infer Args) => object
  ? Args
  : never)["lock"]

type Files = FileSystem.FileSystem | Path.Path

type Platform = Crypto.Crypto | FileSystem.FileSystem | Path.Path | Stdio.Stdio

// Test time starts here, so a released lease (expiring at 0) is long expired.
const BASE_TIME = 1_000_000,
  DEFAULT_TTL_MS = 20_000,
  LeaseExpiry = Schema.fromJsonString(
    Schema.Struct({ expiresAt: Schema.Number }),
  ),
  NANOS_PER_MILLI = 1_000_000n,
  OTHER_PID = 1,
  /** A lease as another process writes it. */
  OtherLease = Schema.fromJsonString(
    Schema.Struct({
      expiresAt: Schema.Number,
      owner: Schema.String,
      pid: Schema.Number,
    }),
  ),
  /*
   * First 16 hex of sha256(SOURCE), pinned as a literal so a change to the
   * ticket naming scheme fails here instead of silently orphaning every live
   * lock.
   */
  PREFIX = "oc-auth-refresh-e9c5dce8a55501f4-",
  SOURCE = "Claude Code-credentials",
  /* Set the test clock `offset` milliseconds past the base time. */
  at = (offset: number): Effect.Effect<void> =>
    TestClock.setTime(BASE_TIME + offset),
  /* Empty every ticket in `dir`, as if each had just been created. */
  blankTickets = Effect.fn("test.blankTickets")(function* blankTickets(
    dir: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path

    yield* fs
      .readDirectory(dir)
      .pipe(
        Effect.flatMap(
          Effect.forEach((name: string) =>
            fs.writeFileString(path.join(dir, name), ""),
          ),
        ),
      )
  }),
  /* A lock directory under `dir` that cannot be created: its parent is a file. */
  blockedDir = Effect.fn("test.blockedDir")(function* blockedDir(dir: string) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path

    yield* fs.writeFileString(path.join(dir, "not-a-dir"), "x")

    return path.join(dir, "not-a-dir", "sub")
  }),
  /*
   * A clock frozen at the base time that runs `hook` on every read, so a test
   * can act in the window between two steps of an acquisition.
   */
  frozenClock = (hook: Effect.Effect<void>): Clock.Clock => ({
    currentTimeMillis: hook.pipe(Effect.as(BASE_TIME)),
    currentTimeMillisUnsafe: (): number => BASE_TIME,
    currentTimeNanos: Effect.succeed(BigInt(BASE_TIME) * NANOS_PER_MILLI),
    currentTimeNanosUnsafe: (): bigint => BigInt(BASE_TIME) * NANOS_PER_MILLI,
    monotonicTimeNanos: Effect.succeed(BigInt(BASE_TIME) * NANOS_PER_MILLI),
    monotonicTimeNanosUnsafe: (): bigint => BigInt(BASE_TIME) * NANOS_PER_MILLI,
    sleep: (): Effect.Effect<void> => Effect.void,
  }),
  /* The lock in `attempt`; anything else fails the test. */
  held = (attempt: Attempt): Effect.Effect<HeldLock> =>
    LockAttempt.$match(attempt, {
      Busy: () => Effect.die("the lock is busy"),
      Cooldown: () => Effect.die("the lock is cooling down"),
      Held: ({ lock }) => Effect.succeed(lock),
    }),
  /* Whether `attempt` granted the lock. */
  isHeld = (attempt: Attempt): boolean => LockAttempt.$is("Held")(attempt),
  /* When the lease in the ticket at `path` ends. */
  leaseExpiry = Effect.fn("test.leaseExpiry")(function* leaseExpiry(
    path: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      text = yield* fs.readFileString(path)

    return (yield* Schema.decodeUnknownEffect(LeaseExpiry)(text)).expiresAt
  }),
  /* The lock service over `dir`, leasing for `ttlMs`. */
  locks = (
    dir: string,
    ttlMs: number,
  ): Layer.Layer<RefreshLock, Config.ConfigError, Platform> => {
    const environment = testEnvironment({
      HOME: dir,
      OC_AUTH_REFRESH_LOCK_DIR: dir,
      OC_AUTH_REFRESH_LOCK_TTL_MS: String(ttlMs),
    })

    return RefreshLock.layer.pipe(
      Layer.provide(DebugLog.layer),
      Layer.provide(environment),
    )
  },
  /*
   * The lock service over `dir`, leasing for `ttlMs`, built in the caller's
   * scope. `Effect.provide` would close a scope of its own around the call,
   * and with it release every lock taken inside.
   */
  provision = Effect.fn("test.provision")(function* provision(
    dir: string,
    ttlMs: number,
  ) {
    const context = yield* Layer.build(locks(dir, ttlMs))

    return Context.get(context, RefreshLock)
  }),
  /* Ask a lock service over `dir`, leasing for `ttlMs`, for the lock on `source`. */
  request = (
    dir: string,
    ttlMs: number,
    source: string,
  ): Effect.Effect<Attempt, Config.ConfigError, Platform | Scope.Scope> =>
    provision(dir, ttlMs).pipe(
      Effect.flatMap((service) => service.acquire(source)),
    ),
  /* Ask one lock service over `dir` for the lock on the usual source twice. */
  requestTwice = (
    dir: string,
  ): Effect.Effect<
    { readonly first: Attempt; readonly second: Attempt },
    Config.ConfigError,
    Platform | Scope.Scope
  > =>
    provision(dir, DEFAULT_TTL_MS).pipe(
      Effect.flatMap((service) =>
        Effect.all({
          first: service.acquire(SOURCE),
          second: service.acquire(SOURCE),
        }),
      ),
    ),
  /* A scoped temporary directory, with the test clock at the base time. */
  sandbox = Effect.gen(function* makeSandbox() {
    const fs = yield* FileSystem.FileSystem

    yield* TestClock.setTime(BASE_TIME)

    return yield* fs.makeTempDirectoryScoped({
      prefix: "oc-auth-lock-",
    })
  }),
  /* Ask for the lock on the usual source at `offset` past the base time. */
  takeLock = (
    dir: string,
    ttlMs: number,
    offset: number,
  ): Effect.Effect<Attempt, Config.ConfigError, Platform | Scope.Scope> =>
    at(offset).pipe(Effect.andThen(request(dir, ttlMs, SOURCE))),
  /* Ask for the lock on `source` at the current time, with the default lease. */
  takeSource = (
    dir: string,
    source: string,
  ): Effect.Effect<Attempt, Config.ConfigError, Platform | Scope.Scope> =>
    request(dir, DEFAULT_TTL_MS, source),
  /* The path of `ticket` of the usual source in `dir`. */
  ticketPath = Effect.fn("test.ticketPath")(function* ticketPath(
    dir: string,
    ticket: number,
  ) {
    const path = yield* Path.Path

    return path.join(dir, `${PREFIX}${ticket}.lock`)
  }),
  /*
   * Ask for the lock with the clock frozen at the base time, running `inject`
   * at the first clock read where `ready` holds. Reports whether it ran.
   */
  withInjection = Effect.fn("test.withInjection")(function* withInjection(
    dir: string,
    ready: Effect.Effect<boolean, PlatformError.PlatformError>,
    inject: Effect.Effect<unknown, PlatformError.PlatformError, Files>,
  ) {
    const context = yield* Effect.context<Files>(),
      flag = yield* Ref.make(false),
      gate = Effect.zipWith(
        Ref.get(flag),
        ready.pipe(Effect.orElseSucceed(() => false)),
        (done, isReady) => !done && isReady,
      ),
      hook = inject.pipe(
        Effect.provideContext(context),
        Effect.andThen(Ref.set(flag, true)),
        Effect.when(gate),
        Effect.asVoid,
        Effect.orDie,
      ),
      outcome = yield* request(dir, DEFAULT_TTL_MS, SOURCE).pipe(
        Effect.provideService(Clock.Clock, frozenClock(hook)),
      )

    return { attempt: outcome, injected: yield* Ref.get(flag) }
  }),
  /* Write a file named each of `names` in `dir`, holding a lease ending at `expiresAt`. */
  writeStrays = Effect.fn("test.writeStrays")(function* writeStrays(
    dir: string,
    names: readonly string[],
    expiresAt: number,
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      write = (
        name: string,
      ): Effect.Effect<void, PlatformError.PlatformError> =>
        fs.writeFileString(path.join(dir, name), JSON.stringify({ expiresAt }))

    yield* Effect.succeed(names).pipe(
      Effect.flatMap(Effect.forEach((name: string) => write(name))),
    )
  }),
  /* Write `ticket` as another process would, with a lease ending at `expiresAt`. */
  writeTicket = Effect.fn("test.writeTicket")(function* writeTicket(
    dir: string,
    ticket: number,
    expiresAt: number,
  ) {
    const fs = yield* FileSystem.FileSystem,
      lease = yield* Schema.encodeEffect(OtherLease)({
        expiresAt,
        owner: "other",
        pid: OTHER_PID,
      }).pipe(Effect.orDie),
      path = (yield* Path.Path).join(dir, `${PREFIX}${ticket}.lock`)

    yield* fs.writeFileString(path, lease)

    return path
  })

/** What the refresh-lock tests share. */
export default Object.freeze({
  at,
  base: BASE_TIME,
  blankTickets,
  blockedDir,
  held,
  isHeld,
  layer: Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer,
    NodeCrypto.layer,
    CapturedStderr.layer,
  ),
  leaseExpiry,
  locks,
  prefix: PREFIX,
  requestTwice,
  sandbox,
  source: SOURCE,
  takeLock,
  takeSource,
  ticketPath,
  withInjection,
  writeStrays,
  writeTicket,
})
