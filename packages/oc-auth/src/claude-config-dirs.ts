import { Effect, FileSystem, Option, Path, Schema } from "effect"
import Environment from "./environment.ts"
import pluginLog from "./plugin-log.ts"
import sources from "./claude-code-sources.ts"

const ACCOUNT_FILE = ".claude.json",
  /** An account's email; absent or null when Claude Code recorded none. */
  EmailAddress = Schema.optionalKey(Schema.NullOr(Schema.String)),
  NONE = 0,
  /** The signed-in account `.claude.json` records, or null. */
  OAuthAccount = Schema.NullOr(Schema.Struct({ emailAddress: EmailAddress })),
  /*
   * The part of `.claude.json` that names the signed-in account. A file
   * without the account, or without its email, is valid: Claude Code keeps
   * the file before anyone signs in.
   */
  UserConfigFile = Schema.fromJsonString(
    Schema.Struct({ oauthAccount: Schema.optionalKey(OAuthAccount) }),
  ),
  /*
   * Warn that the `.claude.json` at `path` is not the JSON Claude Code
   * writes, so its account is labeled without an email. The parser's
   * message quotes the file, so the debug record names only the path.
   */
  accountFileMalformed = (path: string): Effect.Effect<Option.Option<string>> =>
    pluginLog
      .warning("account_file_malformed", {})
      .pipe(
        Effect.andThen(pluginLog.debug("account_file_malformed", { path })),
        Effect.as(Option.none()),
      ),
  /*
   * Warn that the `.claude.json` at `path` exists but could not be read, so
   * its account is labeled without an email.
   */
  accountFileUnreadable = (
    path: string,
    failure: { readonly message: string },
  ): Effect.Effect<Option.Option<string>> =>
    pluginLog.warning("account_file_unreadable", {}).pipe(
      Effect.andThen(
        pluginLog.debug("account_file_unreadable", {
          error: failure.message,
          path,
        }),
      ),
      Effect.as(Option.none()),
    ),
  /* The email `text`, a `.claude.json`, names, or none when it names none. */
  decodeEmail = (
    text: string,
  ): Effect.Effect<Option.Option<string>, Schema.SchemaError> =>
    Schema.decodeEffect(UserConfigFile)(text).pipe(
      Effect.map((file) =>
        Option.fromNullishOr(file.oauthAccount).pipe(
          Option.flatMap((account) =>
            Option.fromNullishOr(account.emailAddress),
          ),
          Option.filter((email) => email !== ""),
        ),
      ),
    ),
  /*
   * The email the `.claude.json` at `path` names, or none. A missing file
   * is no failure; one that cannot be read or parsed is warned about.
   */
  emailAt = Effect.fn("ClaudeConfigDirs.emailAt")(
    function* emailAt(path: string) {
      const fs = yield* FileSystem.FileSystem,
        text = yield* fs.readFileString(path)

      return yield* decodeEmail(text)
    },
    (effect, path) =>
      effect.pipe(
        Effect.catchReason(
          "PlatformError",
          "NotFound",
          () => Effect.succeedNone,
        ),
        Effect.catchTags({
          PlatformError: (failure: { readonly message: string }) =>
            accountFileUnreadable(path, failure),
          SchemaError: () => accountFileMalformed(path),
        }),
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
    Effect.orElseSucceed(() => false),
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
   * The config directory each suffix in `needed` was hashed from. Claude
   * Code names a non-primary item after its config directory, and those
   * directories live in the home directory unless `CLAUDE_CONFIG_DIR` points
   * elsewhere. An unmapped suffix only loses its config directory and email
   * label, so a failed scan is logged and otherwise ignored.
   */
  suffixMap = Effect.fn("ClaudeConfigDirs.configDirsBySuffix")(
    function* suffixMap(needed: readonly string[]) {
      const environment = yield* Environment,
        scanned = yield* homeConfigDirs.pipe(
          Effect.catchTag(
            "PlatformError",
            (failure: { readonly message: string }) =>
              pluginLog
                .debug("suffix_scan_failed", { error: failure.message })
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

/** What each Claude Code config directory says about its account. */
export default Object.freeze({ configDirsBySuffix: suffixMap, readEmail })
