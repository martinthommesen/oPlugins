import type { Config, Crypto, Path } from "effect"
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  PlatformError,
} from "effect"
import type { ChildProcessSpawner } from "effect/process"
import ClaudeCodeStores from "./claude-code-stores.ts"
import support from "./claude-code-stores.test-support.ts"
import testEnvironment from "./test-environment.test-support.ts"

type Stores = ClaudeCodeStores["Service"]

/** One file operation that fails, by path, and the errno code it fails with. */
interface FileFault {
  readonly code: string
  /** Whether the fault applies to the operation on `path`. */
  readonly matches: (path: string) => boolean
  readonly operation: "readDirectory" | "remove" | "rename" | "stat" | "sync"
}

/* A fault failing `operation` on any path ending with `suffix`, with `code`. */
const failAt = (
    operation: FileFault["operation"],
    suffix: string,
    code: string,
  ): FileFault => ({
    code,
    matches: (path) => path.endsWith(suffix),
    operation,
  }),
  /* `effect`, unless `fault` is some: then a failure with its errno code. */
  failingWith = <Value>(
    fault: Option.Option<FileFault>,
    effect: Effect.Effect<Value, PlatformError.PlatformError>,
  ): Effect.Effect<Value, PlatformError.PlatformError> =>
    Option.match(fault, {
      onNone: () => effect,
      onSome: (found) =>
        Effect.fail(
          PlatformError.badArgument({
            cause: { code: found.code },
            description: `injected ${found.code}`,
            method: found.operation,
            module: "FileSystem",
          }),
        ),
    }),
  /* The fault among `faults` on `operation` of `path`, if any. */
  faultOn = (
    faults: readonly FileFault[],
    operation: FileFault["operation"],
    path: string,
  ): Option.Option<FileFault> =>
    Option.fromUndefinedOr(
      faults.find(
        (fault) => fault.operation === operation && fault.matches(path),
      ),
    ),
  /* `file`, opened at `path`, with its sync failing per `faults`. */
  faultyFile = (
    file: FileSystem.File,
    faults: readonly FileFault[],
    path: string,
  ): FileSystem.File => ({
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    read: (buffer) => file.read(buffer),
    readAlloc: (size) => file.readAlloc(size),
    seek: (offset, from) => file.seek(offset, from),
    stat: file.stat,
    sync: failingWith(faultOn(faults, "sync", path), file.sync),
    truncate: (length) => file.truncate(length),
    write: (buffer) => file.write(buffer),
    writeAll: (buffer) => file.writeAll(buffer),
  }),
  /* The real file system, with the operations `faults` names failing. */
  faultyFiles = (
    faults: readonly FileFault[],
  ): Layer.Layer<FileSystem.FileSystem, never, FileSystem.FileSystem> =>
    Layer.effect(
      FileSystem.FileSystem,
      FileSystem.FileSystem.pipe(
        Effect.map((fs) =>
          FileSystem.makeNoop({
            access: (path, options) => fs.access(path, options),
            chmod: (path, mode) => fs.chmod(path, mode),
            exists: (path) => fs.exists(path),
            open: (path, options) =>
              fs
                .open(path, options)
                .pipe(Effect.map((file) => faultyFile(file, faults, path))),
            readDirectory: (path, options) =>
              failingWith(
                faultOn(faults, "readDirectory", path),
                fs.readDirectory(path, options),
              ),
            readFileString: (path, encoding) =>
              fs.readFileString(path, encoding),
            remove: (path, options) =>
              failingWith(
                faultOn(faults, "remove", path),
                fs.remove(path, options),
              ),
            rename: (oldPath, newPath) =>
              failingWith(
                faultOn(faults, "rename", newPath),
                fs.rename(oldPath, newPath),
              ),
            stat: (path) =>
              failingWith(faultOn(faults, "stat", path), fs.stat(path)),
          }),
        ),
      ),
    ),
  /* The stores of a macOS machine with its home in `home`, on files failing per `faults`. */
  layerOver = (
    home: string,
    faults: readonly FileFault[],
  ): Layer.Layer<
    ClaudeCodeStores,
    Config.ConfigError,
    | ChildProcessSpawner.ChildProcessSpawner
    | Crypto.Crypto
    | FileSystem.FileSystem
    | Path.Path
  > => {
    const machine = Layer.merge(
      testEnvironment({ HOME: home })(),
      faultyFiles(faults),
    )

    return Layer.provide(ClaudeCodeStores.layer, machine)
  },
  /*
   * Run `body` against the stores of a macOS machine with a fresh home
   * directory and an empty Keychain, whose file operations fail per `faults`.
   */
  onMacWith = <Value, Failure>(
    faults: readonly FileFault[],
    body: (stores: Stores) => Effect.Effect<Value, Failure>,
  ): Effect.Effect<
    Value,
    Config.ConfigError | Failure | PlatformError.PlatformError,
    | ChildProcessSpawner.ChildProcessSpawner
    | Crypto.Crypto
    | FileSystem.FileSystem
    | Path.Path
  > =>
    support.sandbox.pipe(
      Effect.flatMap((home) => Layer.build(layerOver(home, faults))),
      Effect.flatMap((context) => body(Context.get(context, ClaudeCodeStores))),
      Effect.scoped,
    )

/** Credential stores over a file system whose operations fail on cue. */
/** @internal */
export default Object.freeze({ failAt, onMacWith })
