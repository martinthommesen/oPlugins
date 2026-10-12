import { Context, Effect, FileSystem, Layer, PlatformError, Ref } from "effect"
import {
  NodeCrypto,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node-shared"
import type LockAttempt from "./refresh-lock-attempt.ts"
import RefreshLock from "./refresh-lock.ts"
import type { Scope } from "effect"
import support from "./refresh-lock.test-support.ts"

type Attempt = ReturnType<(typeof LockAttempt)["Busy" | "Cooldown" | "Held"]>

/** Which lease write fails, and how much of it lands first. */
interface Fault {
  /** The failing write, counting every ticket write from 1. */
  readonly failing: number
  /** Runs when the write fails. */
  readonly onFault: Effect.Effect<void>
  /** The bytes of the failing write that reach the file before it fails. */
  readonly partial: number
}

/* How an injected write failure fails. */
const BROKEN_WRITE = Effect.fail(
    PlatformError.badArgument({
      description: "injected write failure",
      method: "writeAll",
      module: "FileSystem",
    }),
  ),
  DEFAULT_TTL_MS = 20_000,
  NEXT = 1,
  NO_WRITES = 0,
  START = 0,
  /* Fail ticket write `failing`, after `partial` of its bytes land, then run `onFault`. */
  failWrite = (
    failing: number,
    partial: number,
    onFault: Effect.Effect<void> = Effect.void,
  ): Fault => ({ failing, onFault, partial }),
  /* Write `buffer` to `file`, unless it is the write `fault` fails. */
  failingWrite = (
    file: FileSystem.File,
    fault: Fault & { readonly writes: Ref.Ref<number> },
    buffer: Uint8Array,
  ): Effect.Effect<void, PlatformError.PlatformError> =>
    Ref.updateAndGet(fault.writes, (count) => count + NEXT).pipe(
      Effect.flatMap((count) => {
        if (count !== fault.failing) {
          return file.writeAll(buffer)
        }

        return file
          .writeAll(buffer.subarray(START, fault.partial))
          .pipe(Effect.andThen(fault.onFault), Effect.andThen(BROKEN_WRITE))
      }),
    ),
  /* `file`, with its writes failing per `fault`. */
  faultyFile = (
    file: FileSystem.File,
    fault: Fault & { readonly writes: Ref.Ref<number> },
  ): FileSystem.File => ({
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    read: (buffer) => file.read(buffer),
    readAlloc: (size) => file.readAlloc(size),
    seek: (offset, from) => file.seek(offset, from),
    stat: file.stat,
    sync: file.sync,
    truncate: (length) => file.truncate(length),
    write: (buffer) => file.write(buffer),
    writeAll: (buffer) => failingWrite(file, fault, buffer),
  }),
  /*
   * The file system the lock uses, over the real one, with the files it
   * opens writing per `fault`.
   */
  faultyFiles = (
    fault: Fault,
  ): Layer.Layer<FileSystem.FileSystem, never, FileSystem.FileSystem> =>
    Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* makeFaultyFiles() {
        const fs = yield* FileSystem.FileSystem,
          writes = yield* Ref.make(NO_WRITES)

        return FileSystem.makeNoop({
          makeDirectory: (path, options) => fs.makeDirectory(path, options),
          open: (path, options) =>
            fs.open(path, options).pipe(
              Effect.map((file) =>
                faultyFile(file, {
                  failing: fault.failing,
                  onFault: fault.onFault,
                  partial: fault.partial,
                  writes,
                }),
              ),
            ),
          readDirectory: (path, options) => fs.readDirectory(path, options),
          readFileString: (path, encoding) => fs.readFileString(path, encoding),
          remove: (path, options) => fs.remove(path, options),
          stat: (path) => fs.stat(path),
        })
      }),
    ),
  /* A lock service over `dir` whose ticket writes fail per `fault`, built in the caller's scope. */
  faultyLocks = Effect.fn("test.faultyLocks")(function* faultyLocks(
    dir: string,
    fault: Fault,
  ) {
    const context = yield* Layer.build(
      Layer.provide(support.locks(dir, DEFAULT_TTL_MS), faultyFiles(fault)),
    )

    return Context.get(context, RefreshLock)
  }),
  /* The lock on the usual source, from a lock over a fresh directory whose ticket writes fail per `fault`. */
  inFreshDir = Effect.fn("test.inFreshDir")(function* inFreshDir(fault: Fault) {
    const fs = yield* FileSystem.FileSystem,
      root = yield* fs.makeTempDirectoryScoped({ prefix: "oc-auth-lock-" }),
      service = yield* faultyLocks(root, fault)

    return yield* service.acquire(support.source)
  }),
  /* Ask a lock over `dir` whose ticket writes fail per `fault` for the lock on the usual source. */
  takeFaulty = (
    dir: string,
    fault: Fault,
  ): Effect.Effect<
    Attempt,
    never,
    Layer.Success<typeof support.layer> | Scope.Scope
  > =>
    faultyLocks(dir, fault).pipe(
      Effect.flatMap((service) => service.acquire(support.source)),
      Effect.orDie,
    ),
  /*
   * The lock on the usual source, from a lock over a fresh directory on
   * Node's platform whose ticket writes fail per `fault`.
   */
  takeFaultyAnywhere = Effect.fn("test.takeFaultyAnywhere")(
    function* takeFaultyAnywhere(fault: Fault) {
      const context = yield* Layer.build(
        Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer),
      )

      return yield* inFreshDir(fault).pipe(Effect.provideContext(context))
    },
    Effect.orDie,
  )

/** Refresh locks whose ticket writes fail on cue. */
export default Object.freeze({ failWrite, takeFaulty, takeFaultyAnywhere })
