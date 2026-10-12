import { Array as Arr, Effect, Option, Ref } from "effect"
import commands from "./fake-security-commands.test-support.ts"

type Outcome = ReturnType<typeof commands.done>

type Session = Parameters<typeof commands.dumpKeychain>[typeof FIRST]

const FIRST = 0,
  /**
   * The longest command `security -i` reads from one line. The real tool
   * counts bytes; this fake counts characters, which is the same for ASCII.
   */
  INTERACTIVE_CHUNK = 4095,
  NEXT = 1,
  /** One `security -i` word: quoted runs, escapes, and plain characters. */
  TOKEN = /(?:\\[\s\S]|\\$|"(?:\\[\s\S]|\\$|[^"\\])*(?:"|$)|[^\s"\\])+/gu,
  UNESCAPE = /\\(?<char>[\s\S])|"/gu,
  /* The 4095-character fragments `security -i` splits `line` into. */
  fragments = (line: string): readonly string[] =>
    Arr.makeBy(
      Math.max(Math.ceil(line.length / INTERACTIVE_CHUNK), NEXT),
      (index) =>
        line.slice(
          index * INTERACTIVE_CHUNK,
          (index + NEXT) * INTERACTIVE_CHUNK,
        ),
    ),
  /* Split one `security -i` line the way the real tool does. */
  parseLine = (line: string): readonly string[] =>
    (line.match(TOKEN) ?? []).map((word) =>
      word.replaceAll(UNESCAPE, (_quote: string, char?: string) => char ?? ""),
    ),
  /* One `security` command, as argv. */
  runCommand = (
    session: Session,
    argv: readonly string[],
  ): Effect.Effect<Outcome> => {
    const [command, ...args] = argv

    if (command === "dump-keychain") {
      return commands.dumpKeychain(session)
    }

    if (command === "find-generic-password") {
      return commands.findGenericPassword(session, args)
    }

    if (command === "add-generic-password") {
      return commands.addGenericPassword(session, args)
    }

    return Effect.succeed(commands.done(commands.EXIT_FAILURE))
  },
  /*
   * `security -i`: commands read from stdin in 4096-byte line chunks. A
   * longer line is split, and its first fragment still runs. Stdin is
   * consumed, so a prompt inside reads EOF.
   */
  runInteractive = Effect.fn("FakeSecurity.runInteractive")(
    function* runInteractive(files: Session["files"], input: string) {
      const blank = yield* Ref.make<readonly string[]>([]),
        commandLines = input
          .split("\n")
          .flatMap((line) => fragments(line))
          .map((fragment) => parseLine(fragment))
          .filter((words) => words.length > FIRST),
        outcomes = yield* Effect.forEach(
          commandLines,
          (words) => runCommand({ files, prompts: blank }, words),
          { concurrency: 1 },
        ),
        status = Arr.last(
          outcomes.filter((outcome) => outcome.code !== commands.EXIT_SUCCESS),
        )

      return commands.done(
        Option.match(status, {
          onNone: () => commands.EXIT_SUCCESS,
          onSome: (failed) => failed.code,
        }),
        outcomes.map((outcome) => outcome.stdout).join(""),
      )
    },
  ),
  /*
   * A `security` stand-in backed by `files`: one file per service holding
   * its blob, `<service>.account` for the item's account name,
   * `<service>.exit` to force an exit status, and `dump` for
   * `dump-keychain`. Writes land in `<service>` and record the account used
   * in `<service>.written-as`. `<service>.drop`, `<service>.drop-once`, and
   * `<service>.flip` disturb writes, as `fake-security-commands` describes.
   *
   * It mirrors the real tool where the real tool is surprising, because the
   * plugin's write path depends on those details (each was checked against
   * `/usr/bin/security` on macOS):
   * - `-w` as the last argument prompts twice through getpass, which reads
   *   stdin when there is no terminal, keeps at most 128 characters, reads
   *   EOF as an empty string, and accepts two matching empty entries.
   * - `-i` executes commands read from stdin in 4096-byte line chunks; a
   *   longer line is split, and its first fragment still runs.
   * - Account names print verbatim between quotes, or as `0x<hex>` followed
   *   by an octal-escaped form when they hold a backslash or non-ASCII bytes.
   * - `find-generic-password -w` prints a password holding any byte outside
   *   printable ASCII as bare lowercase hex.
   */
  runSecurity = Effect.fn("FakeSecurity.runSecurity")(function* runSecurity(
    files: Session["files"],
    argv: readonly string[],
    input: string,
  ) {
    const prompts = yield* Ref.make<readonly string[]>(input.split("\n"))

    if (argv[FIRST] === "-i") {
      return yield* runInteractive(files, input)
    }

    return yield* runCommand({ files, prompts }, argv)
  })

/** The `security` tool, simulated over a map of named files. */
export default Object.freeze({ runSecurity })
