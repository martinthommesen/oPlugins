import { Brand, Context, Effect, Layer, Option, Redacted } from "effect"
import type { Credential, Plugin } from "@opencode/plugin/effect"
import { describe, expect, it } from "@effect/vitest"
import type { Cause } from "effect"
import Host from "./host.ts"
import type HostError from "./host-error.ts"

type Connection = Plugin.Context["integration"]["connection"]

type ConnectionInfo = NonNullable<
  Effect.Success<ReturnType<Connection["active"]>>
>

type SignIn = Option.Option.Value<
  Effect.Success<ReturnType<Host["Service"]["signIn"]>>
>

/* The host dying as it reads the active connection. */
const DYING = Effect.die(new Error("connection unavailable")),
  EXPIRES = 0,
  /** A stored credential, as the host lists the active connection. */
  STORED = {
    id: "cred_1",
    label: "Claude Max: me@example.com",
    method: "oauth",
    type: "credential",
  } satisfies ConnectionInfo,
  /** A host call the test expects not to be made. */
  UNUSED = Effect.die("unused"),
  /* The access token and account `signIn` grants, in plain text. */
  accessOf = (
    signIn: SignIn,
  ): Effect.Effect<
    Option.Option<readonly [string, Option.Option<string>]>,
    HostError
  > =>
    signIn.access.pipe(
      Effect.map(
        Option.map(
          (access) => [Redacted.value(access.token), access.accountId] as const,
        ),
      ),
    ),
  asMethodID = Brand.nominal<Credential.OAuth["methodID"]>(),
  /* Anthropic's connection, when the host reports `active` and resolves it to `resolved`. */
  connected = <Failure>(
    active: Effect.Effect<ConnectionInfo | undefined>,
    resolved: Effect.Effect<Credential.Value | undefined, Failure>,
  ): Effect.Effect<Option.Option<SignIn>, HostError> =>
    Layer.build(
      Host.fromPlugin({
        integration: {
          connection: { active: () => active, resolve: () => resolved },
        },
      }),
    ).pipe(
      Effect.flatMap((built) => Context.get(built, Host).signIn("anthropic")),
      Effect.scoped,
    ),
  /* An OAuth credential holding `access`, with `metadata`. */
  oauth = (
    access: string,
    metadata: Readonly<Record<string, string>>,
  ): Credential.OAuth => ({
    access,
    expires: EXPIRES,
    metadata,
    methodID: asMethodID("chatgpt-browser"),
    refresh: "refresh",
    type: "oauth",
  }),
  /* The sign-in of a stored connection that resolves to `resolved`. */
  storedSignIn = <Failure>(
    resolved: Effect.Effect<Credential.Value | undefined, Failure>,
  ): Effect.Effect<SignIn, Cause.NoSuchElementError | HostError> =>
    connected(Effect.succeed(STORED), resolved).pipe(
      Effect.flatMap(Effect.fromOption),
    )

describe("a stored OAuth connection", () => {
  it.effect("is told apart by its ID and label, and grants its token", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const signIn = yield* storedSignIn(
        Effect.succeed(oauth("token", { accountID: "acct-1" })),
      )

      expect(signIn.identity).toBe(
        "credential:cred_1:Claude Max: me@example.com",
      )
      expect(yield* accessOf(signIn)).toStrictEqual(
        Option.some(["token", Option.some("acct-1")]),
      )
    }),
  )
})

describe("a connection that isn't an OAuth sign-in", () => {
  it.effect("grants no access for an API key", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const signIn = yield* storedSignIn(
        Effect.succeed({ key: "sk-ant-api", type: "key" }),
      )

      expect(yield* accessOf(signIn)).toStrictEqual(Option.none())
    }),
  )

  it.effect("is told apart by its environment variable", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const signIn = yield* connected(
        Effect.succeed({ name: "ANTHROPIC_API_KEY", type: "env" }),
        Effect.undefined,
      ).pipe(Effect.flatMap(Effect.fromOption))

      expect(signIn.identity).toBe("env:ANTHROPIC_API_KEY")
    }),
  )
})

describe("no connection", () => {
  it.effect("is none", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      expect(yield* connected(Effect.undefined, UNUSED)).toStrictEqual(
        Option.none(),
      )
    }),
  )
})

describe("a host call that fails", () => {
  it.effect("reports a malformed OAuth token rather than an API key", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const signIn = yield* storedSignIn(Effect.succeed(oauth("", {}))),
        thrown = yield* Effect.flip(signIn.access)

      expect(thrown.operation).toBe("integration.connection.decode")
    }),
  )
  it.effect("is a HostError naming the call", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const signIn = yield* storedSignIn(Effect.fail("refresh failed")),
        thrown = yield* Effect.flip(signIn.access)

      expect(thrown.operation).toBe("integration.connection.resolve")
    }),
  )

  it.effect("names the active connection when the host dies reading it", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const thrown = yield* Effect.flip(connected(DYING, UNUSED))

      expect(thrown.operation).toBe("integration.connection.active")
    }),
  )
})
