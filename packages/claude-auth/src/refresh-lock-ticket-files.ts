import { Array as Arr, Effect, FileSystem, Option, Path, Schema } from "effect"
import type RefreshLockClaim from "./refresh-lock-claim.ts"
import tickets from "./refresh-lock-tickets.ts"

type Claim = typeof RefreshLockClaim.Type

const Lease = Schema.fromJsonString(
    Schema.Struct({
      cooldown: Schema.optionalKey(Schema.Boolean),
      expiresAt: Schema.Finite,
      owner: Schema.optionalKey(Schema.String),
    }),
  ),
  /*
   * When the ticket at `path` stops being live without a readable lease:
   * `ttlMs` after it was last modified. None when it cannot be examined.
   */
  fallbackExpiry = Effect.fn("RefreshLock.fallbackExpiry")(
    function* fallbackExpiry(path: string, ttlMs: number) {
      const fs = yield* FileSystem.FileSystem,
        info = yield* fs.stat(path)

      if (Option.isNone(info.mtime)) {
        return Option.none<number>()
      }

      return Option.some(info.mtime.value.getTime() + ttlMs)
    },
    Effect.orElseSucceed(() => Option.none<number>()),
  ),
  /* The lease written in the ticket at `path`, or none when it has none. */
  leaseAt = Effect.fn("RefreshLock.readLease")(function* leaseAt(path: string) {
    const fs = yield* FileSystem.FileSystem

    return yield* fs.readFileString(path).pipe(
      Effect.map((text) => Schema.decodeUnknownOption(Lease)(text)),
      Effect.orElseSucceed(() => Option.none<typeof Lease.Type>()),
    )
  }),
  /* The claim the ticket at `path` makes, or none when it is gone. */
  readClaim = Effect.fn("RefreshLock.readClaim")(function* readClaim(
    path: string,
    ticket: bigint,
    ttlMs: number,
  ) {
    const lease = yield* leaseAt(path)

    if (Option.isSome(lease)) {
      return Option.some<Claim>({
        cooldown: lease.value.cooldown === true,
        expiresAt: lease.value.expiresAt,
        path,
        ticket,
      })
    }

    /*
     * A ticket is empty between its creation and the first lease write. Later
     * writes overwrite it in place at a fixed width, so it is never empty again.
     */
    return (yield* fallbackExpiry(path, ttlMs)).pipe(
      Option.map(
        (expiresAt): Claim => ({ cooldown: false, expiresAt, path, ticket }),
      ),
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
    yield* fs.remove(path).pipe(Effect.ignore)
  }),
  /* Every claim on the tickets of `prefix` in `dir`. Fails when `dir` cannot be read. */
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
