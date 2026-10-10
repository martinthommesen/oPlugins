import { Effect, FileSystem, Option, Path, Schema } from "effect"
import DebugLog from "./debug-log.ts"
import Environment from "./environment.ts"
import sources from "./claude-code-sources.ts"

const ACCOUNT_FILE = ".claude.json",
  /** The part of `.claude.json` that names the signed-in account. */
  AccountFile = Schema.fromJsonString(
    Schema.Struct({
      oauthAccount: Schema.Struct({ emailAddress: Schema.NonEmptyString }),
    }),
  ),
  NONE = 0,
  /* The email `.claude.json` at `path` names, or none. */
  emailAt = (
    path: string,
  ): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem> =>
    Effect.gen(function* readEmail() {
      const fs = yield* FileSystem.FileSystem

      return yield* fs.readFileString(path)
    }).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map((text) =>
        Schema.decodeUnknownOption(AccountFile)(text).pipe(
          Option.map((file) => file.oauthAccount.emailAddress),
        ),
      ),
    ),
  /* Whether `dir` is a directory holding a `.claude.json`. */
  holdsAccountFile = Effect.fn("ClaudeConfigDirs.isConfigDir")(
    function* holdsAccountFile(dir: string) {
      const fs = yield* FileSystem.FileSystem,
        info = yield* fs.stat(dir),
        path = yield* Path.Path

      return (
        info.type === "Directory" &&
        (yield* fs.exists(path.join(dir, ACCOUNT_FILE)))
      )
    },
    (effect) => Effect.orElseSucceed(effect, () => false),
  ),
  /* The dot directories in the home directory that hold a `.claude.json`. */
  homeConfigDirs = Effect.gen(function* homeConfigDirs() {
    const environment = yield* Environment,
      fs = yield* FileSystem.FileSystem,
      names = yield* fs.readDirectory(environment.variables.home),
      path = yield* Path.Path,
      subdirs = names
        .filter((name) => name.startsWith("."))
        .map((name) => path.join(environment.variables.home, name)),
      withFile = yield* Effect.forEach(
        subdirs,
        (dir) => holdsAccountFile(dir),
        { concurrency: "unbounded" },
      )

    return subdirs.filter((_dir, index) => withFile[index] === true)
  }),
  /*
   * The account email recorded for `configDir`. The primary directory's
   * account file can also sit directly in the home directory.
   */
  readEmail = Effect.fn("ClaudeConfigDirs.readEmail")(function* readEmail(
    configDir: string,
  ) {
    const environment = yield* Environment,
      path = yield* Path.Path,
      primary = yield* sources.primaryConfigDir,
      selected = [
        path.join(configDir, ACCOUNT_FILE),
        ...[path.join(environment.variables.home, ACCOUNT_FILE)].filter(
          () => configDir === primary,
        ),
      ],
      stated = yield* Effect.forEach(
        selected,
        (candidate) => emailAt(candidate),
        { concurrency: "unbounded" },
      )

    return Option.firstSomeOf(stated)
  }),
  /*
   * The config directory each of `needed` suffixes hashes from. Claude Code
   * names a non-primary item after its config directory, and those
   * directories live in the home directory unless CLAUDE_CONFIG_DIR points
   * elsewhere. Unmapped suffixes only lose their config directory and email
   * label, so a failed scan is logged and otherwise ignored.
   */
  suffixMap = Effect.fn("ClaudeConfigDirs.bySuffix")(
    function* suffixMap(needed: readonly string[]) {
      const debug = yield* DebugLog,
        environment = yield* Environment,
        scanned = yield* homeConfigDirs.pipe(
          Effect.catchTag(
            "PlatformError",
            (failure: { readonly message: string }) =>
              debug
                .log("suffix_scan_failed", { error: failure.message })
                .pipe(Effect.as([])),
          ),
        ),
        searched = [
          ...Option.toArray(environment.variables.claudeConfigDir),
          ...scanned,
        ],
        suffixed = yield* Effect.forEach(
          searched,
          (dir) =>
            sources
              .keychainSuffixForDir(dir)
              .pipe(Effect.map((suffix) => [suffix, dir] as const)),
          { concurrency: "unbounded" },
        )

      // Reversed, so the first directory found for a suffix wins.
      return Object.fromEntries(
        suffixed.filter(([suffix]) => needed.includes(suffix)).toReversed(),
      ) satisfies Readonly<Record<string, string>>
    },
    (effect, needed) =>
      Effect.suspend(() => {
        if (needed.length === NONE) {
          return Effect.succeed<Readonly<Record<string, string>>>({})
        }

        return effect
      }),
  )

/** What the Claude config directories on this machine say about accounts. */
export default Object.freeze({ configDirsBySuffix: suffixMap, readEmail })
