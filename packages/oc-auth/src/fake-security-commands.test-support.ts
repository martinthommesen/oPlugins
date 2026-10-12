import { Effect, HashMap, Option, Ref, Result } from "effect"
import { Hex } from "effect/encoding"

/** One run of the fake tool: the Keychain's files and the unread stdin. */
interface Session {
  /** The fake Keychain's state, as named files. */
  readonly files: Ref.Ref<HashMap.HashMap<string, string>>
  /** Stdin lines a `getpass` prompt has not read yet. */
  readonly prompts: Ref.Ref<readonly string[]>
}

/** What one `security` invocation printed and exited with. */
interface Outcome {
  readonly code: number
  readonly stdout: string
}

const ATTEMPTS = 3,
  EXIT_FAILURE = 1,
  EXIT_NOT_FOUND = 44,
  EXIT_SUCCESS = 0,
  FIRST = 0,
  GETPASS_MAX = 128,
  MISSING = -1,
  NEXT = 1,
  OCTAL_RADIX = 8,
  OCTAL_WIDTH = 3,
  /* Printable ASCII other than a backslash prints verbatim. */
  PLAIN_ACCOUNT = /^[\u0020-\u005B\u005D-\u007E]*$/u,
  PRINTABLE = /^[\u0020-\u007E]*$/u,
  codec = new TextEncoder(),
  done = (code: number, stdout = ""): Outcome => ({ code, stdout }),
  fileOf = (
    session: Session,
    name: string,
  ): Effect.Effect<Option.Option<string>> =>
    Ref.get(session.files).pipe(Effect.map(HashMap.get(name))),
  fromHex = (hex: string): Option.Option<string> =>
    Result.getSuccess(Hex.decodeString(hex)),
  /* `getpass`: the next stdin line, at most 128 characters; EOF reads as "". */
  getpass = (session: Session): Effect.Effect<string> =>
    Ref.modify(session.prompts, (lines) => [
      (lines[FIRST] ?? "").slice(FIRST, GETPASS_MAX),
      lines.slice(NEXT),
    ]),
  /* The value after `flag` in `args`. */
  option = (args: readonly string[], flag: string): Option.Option<string> => {
    const index = args.indexOf(flag)

    if (index === MISSING) {
      return Option.none()
    }

    return Option.fromUndefinedOr(args[index + NEXT])
  },
  /* A stored password as `-w` prints it. */
  passwordText = (stored: string): string => {
    if (PRINTABLE.test(stored)) {
      return stored
    }

    return Hex.encode(stored)
  },
  /*
   * An account name as `find-generic-password` prints it: verbatim between
   * quotes, or as `0x<hex>` followed by an octal-escaped form when it holds
   * a backslash or non-ASCII bytes.
   */
  printAccount = (account: string): string => {
    if (PLAIN_ACCOUNT.test(account)) {
      return `"acct"<blob>="${account}"`
    }

    const bytes = codec.encode(account),
      octal = [...bytes]
        .map((byte) => {
          const char = String.fromCodePoint(byte)

          if (PLAIN_ACCOUNT.test(char)) {
            return char
          }

          return `\\${byte.toString(OCTAL_RADIX).padStart(OCTAL_WIDTH, "0")}`
        })
        .join("")

    return `"acct"<blob>=0x${Hex.encode(bytes).toUpperCase()}  "${octal}"`
  },
  /* A password typed twice, up to three tries, as a trailing `-w` asks. */
  promptTwice = Effect.fn("FakeSecurity.promptTwice")(function* promptTwice(
    session: Session,
    attempts: number,
  ): Effect.fn.Return<Option.Option<string>> {
    const first = yield* getpass(session),
      second = yield* getpass(session)

    if (first === second) {
      return Option.some(first)
    }

    if (attempts <= NEXT) {
      return Option.none<string>()
    }

    return yield* promptTwice(session, attempts - NEXT)
  }),
  putFile = (
    session: Session,
    name: string,
    content: string,
  ): Effect.Effect<void> =>
    Ref.update(session.files, HashMap.set(name, content)),
  /* The password an `add-generic-password` invocation supplies. */
  suppliedPassword = (
    session: Session,
    args: readonly string[],
  ): Effect.Effect<Option.Option<string>> => {
    if (args.includes("-X")) {
      return Effect.succeed(
        option(args, "-X").pipe(Option.flatMap((hex) => fromHex(hex))),
      )
    }

    if (args.at(MISSING) === "-w") {
      return promptTwice(session, ATTEMPTS)
    }

    return Effect.succeed(Option.orElseSome(option(args, "-w"), () => ""))
  },
  unsetFile = (session: Session, name: string): Effect.Effect<void> =>
    Ref.update(session.files, HashMap.remove(name)),
  /*
   * `find-generic-password`. `<service>.exit` forces an exit status. With
   * `-w` it prints the password, as bare lowercase hex when it holds any
   * byte outside printable ASCII; without, the account name. A
   * `<service>.flip` replaces the item right after the account lookup,
   * which models a rotation landing while a write is being prepared.
   */
  viewItem = Effect.fn("FakeSecurity.findGenericPassword")(function* viewItem(
    session: Session,
    args: readonly string[],
  ) {
    const service = Option.getOrElse(option(args, "-s"), () => ""),
      state = yield* Effect.all({
        account: fileOf(session, `${service}.account`),
        exit: fileOf(session, `${service}.exit`),
        flip: fileOf(session, `${service}.flip`),
        stored: fileOf(session, service),
      })

    if (Option.isSome(state.exit)) {
      return done(Number(state.exit.value))
    }

    if (Option.isNone(state.stored)) {
      return done(EXIT_NOT_FOUND)
    }

    if (args.includes("-w")) {
      return done(EXIT_SUCCESS, `${passwordText(state.stored.value)}\n`)
    }

    yield* Option.match(state.flip, {
      onNone: () => Effect.void,
      onSome: (next) =>
        Effect.andThen(
          putFile(session, service, next),
          unsetFile(session, `${service}.flip`),
        ),
    })

    return done(
      EXIT_SUCCESS,
      Option.match(state.account, {
        onNone: () => "",
        onSome: (name) => `    ${printAccount(name)}\n`,
      }),
    )
  }),
  /* `dump-keychain`, which fails with exit status 1 when there is no `dump`. */
  wholeDump = (session: Session): Effect.Effect<Outcome> =>
    fileOf(session, "dump").pipe(
      Effect.map(
        Option.match({
          onNone: () => done(EXIT_FAILURE),
          onSome: (dump) => done(EXIT_SUCCESS, dump),
        }),
      ),
    ),
  /*
   * Where a write lands. `<service>.drop` loses every write while exiting
   * 0; `<service>.drop-once` loses one and leaves its own content (when it
   * has any) in the item, as another writer would.
   */
  writeLanding = Effect.fn("FakeSecurity.landWrite")(function* writeLanding(
    session: Session,
    service: string,
    password: string,
  ) {
    const drop = yield* fileOf(session, `${service}.drop`),
      dropOnce = yield* fileOf(session, `${service}.drop-once`)

    if (Option.isSome(dropOnce)) {
      yield* unsetFile(session, `${service}.drop-once`)

      if (dropOnce.value !== "") {
        yield* putFile(session, service, dropOnce.value)
      }

      return
    }

    if (Option.isNone(drop)) {
      yield* putFile(session, service, password)
    }
  }),
  /* `add-generic-password`, recording the account it wrote as. */
  writtenItem = Effect.fn("FakeSecurity.addGenericPassword")(
    function* writtenItem(session: Session, args: readonly string[]) {
      const password = yield* suppliedPassword(session, args),
        service = Option.getOrElse(option(args, "-s"), () => "")

      if (Option.isNone(password)) {
        return done(EXIT_FAILURE)
      }

      yield* writeLanding(session, service, password.value)
      yield* putFile(
        session,
        `${service}.written-as`,
        Option.getOrElse(option(args, "-a"), () => ""),
      )

      return done(EXIT_SUCCESS)
    },
  )

/** The `security` subcommands the fake tool implements. */
export default Object.freeze({
  EXIT_FAILURE,
  EXIT_SUCCESS,
  addGenericPassword: writtenItem,
  done,
  dumpKeychain: wholeDump,
  findGenericPassword: viewItem,
})
