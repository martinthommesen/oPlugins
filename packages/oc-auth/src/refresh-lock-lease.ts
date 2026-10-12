import { Clock, Effect, Schema } from "effect"
import Environment from "./environment.ts"
import type { FileSystem } from "effect"
import pluginLog from "./plugin-log.ts"
import tickets from "./refresh-lock-tickets.ts"

/** A ticket this process holds open, as a lease write needs it. */
interface Leased {
  readonly file: FileSystem.File
  /** The path-free name of the store in warnings. */
  readonly lock: string
  readonly owner: string
  readonly source: string
}

/** What a lease write is for: the warning about a failed write names it. */
type LeaseKind = "cooldown" | "extension" | "initial"

/*
 * Fixed payload width. A lease is rewritten in place from the start of its
 * ticket, padded to this width, so a complete write replaces every byte of
 * the lease before it and leaves no tail of it behind. JSON parsing ignores
 * the pad. The width doesn't make a write atomic: a reader can catch a write
 * midway, and a write that fails can leave some new bytes over the old ones.
 * Such a mix may decode as either lease, as one that is neither, or not at
 * all, so a lease counts only once its write has succeeded.
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
  encoder = new TextEncoder(),
  /*
   * Report that the `kind` lease on `held` could not be written. Other
   * processes may not see it, so the write counts for nothing.
   */
  failedWrite = (
    held: Leased,
    kind: LeaseKind | "release",
    failure: { readonly message: string },
  ): Effect.Effect<boolean> =>
    pluginLog
      .warning("refresh_lease_unwritten", { lease: kind, lock: held.lock })
      .pipe(
        Effect.andThen(
          pluginLog.debug("refresh_lease_unwritten", {
            error: failure.message,
            lease: kind,
            source: held.source,
          }),
        ),
        Effect.as(false),
      ),
  /* Rewrite the lease on `held` in place to end at `expiresAt`; false when the write fails. */
  inscribe = Effect.fn("RefreshLock.writeLease")(function* inscribe(
    held: Leased,
    kind: LeaseKind | "release",
    expiresAt: number,
  ) {
    const environment = yield* Environment,
      // The fields are plain values, so encoding them cannot fail.
      payload = yield* Schema.encodeEffect(LeaseRecord)({
        cooldown: kind === "cooldown",
        expiresAt,
        owner: held.owner,
        pid: environment.process.pid,
      }).pipe(Effect.orDie),
      payloadBytes = encoder.encode(payload.padEnd(LEASE_BYTES, " "))

    return yield* held.file.seek(START, "start").pipe(
      Effect.andThen(held.file.writeAll(payloadBytes)),
      Effect.as(true),
      Effect.catchTag(
        "PlatformError",
        (failure: { readonly message: string }) =>
          failedWrite(held, kind, failure),
      ),
    )
  }),
  /*
   * Lease `held` as `kind` for `ms` from now, but no longer than the longest
   * lease a reader allows for; false when the write fails.
   */
  lease = (
    held: Leased,
    kind: LeaseKind,
    ms: number,
  ): Effect.Effect<boolean, never, Environment> =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        inscribe(held, kind, now + Math.min(ms, tickets.MAX_LEASE_MS)),
      ),
    ),
  /* End the lease on `held` now; false when the write fails. */
  retire = (held: Leased): Effect.Effect<boolean, never, Environment> =>
    inscribe(held, "release", RELEASED)

/** Writing the lease a held ticket carries. */
export default Object.freeze({ expire: retire, write: lease })
