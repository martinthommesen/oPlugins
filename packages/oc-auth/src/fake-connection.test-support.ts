import {
  Brand,
  Cause,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Ref,
  Struct,
} from "effect"
import type { Credential } from "@opencode/plugin/effect"
import type claudeAuth from "./claude-auth-plugin.ts"
import claudeCodeCredential from "./claude-code-credential.ts"

type Host = Parameters<typeof claudeAuth.setUp>[typeof FIRST]

type Connection = Host["integration"]["connection"]

type ConnectionInfo = NonNullable<
  Effect.Success<ReturnType<Connection["active"]>>
>

/** The host's active Anthropic connection, and the credential it resolves to. */
interface Active {
  readonly connection: ConnectionInfo
  readonly value: Credential.Value
}

/** What the fake connection keeps for one test. */
interface State {
  readonly active: Ref.Ref<Option.Option<Active>>
  readonly dying: Ref.Ref<boolean>
  readonly failing: Ref.Ref<boolean>
  readonly held: Ref.Ref<Option.Option<Deferred.Deferred<boolean>>>
  readonly resolved: Ref.Ref<number>
}

const FIRST = 0,
  /** Far enough ahead that no test token expires unless a test says so. */
  FUTURE_EXPIRY = 10_000_000_000,
  ONE = 1,
  PRIMARY = "Claude Code-credentials",
  /** The connection the host shows for a stored credential. */
  STORED = Object.freeze({
    id: "credential",
    label: "Anthropic",
    method: "oauth" as const,
    type: "credential" as const,
  }),
  /* Die once if a test asked, as the host reports its own problems. */
  activeDefect = (state: State): Effect.Effect<void> =>
    Ref.getAndSet(state.dying, false).pipe(
      Effect.flatMap((dies) =>
        Effect.die(new Error("active connection unavailable")).pipe(
          Effect.when(Effect.succeed(dies)),
        ),
      ),
      Effect.asVoid,
    ),
  /* The active connection, as the host reports it. */
  activeOf =
    (state: State): Connection["active"] =>
    () =>
      activeDefect(state).pipe(
        Effect.andThen(Ref.get(state.active)),
        Effect.map((current) =>
          current.pipe(
            Option.map(Struct.get("connection")),
            Option.getOrUndefined,
          ),
        ),
      ),
  asMethodID = Brand.nominal<Credential.OAuth["methodID"]>(),
  /* An OpenCode credential this plugin imported from the primary store, holding `access`. */
  imported = (access: string, expires: number): Credential.OAuth =>
    claudeCodeCredential.toOAuth(
      claudeCodeCredential.fromSource(
        {
          accessToken: access,
          expiresAt: expires,
          refreshToken: `refresh-${access}`,
        },
        {
          accountLabel: `Claude Pro: ${PRIMARY}`,
          source: PRIMARY,
          sourceTokenHash: "fingerprint",
        },
      ),
    ),
  /* Wait while a test holds resolution, then fail once if a test asked. */
  obstacles = (state: State): Effect.Effect<void, Cause.UnknownError> =>
    Ref.getAndSet(state.held, Option.none()).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (gate) => Deferred.await(gate).pipe(Effect.asVoid),
        }),
      ),
      Effect.andThen(Ref.getAndSet(state.failing, false)),
      Effect.flatMap((fails) =>
        Effect.fail(
          new Cause.UnknownError(
            "credential store unavailable",
            "resolve failed",
          ),
        ).pipe(Effect.when(Effect.succeed(fails))),
      ),
      Effect.asVoid,
    ),
  /*
   * Resolving a connection: counted, then the value of the connection active
   * when it was asked, once obstructed as asked.
   */
  resolveOf =
    (state: State): Connection["resolve"] =>
    () =>
      Ref.update(state.resolved, (count) => count + ONE).pipe(
        Effect.andThen(Ref.get(state.active)),
        Effect.tap(() => obstacles(state)),
        Effect.map((current) =>
          current.pipe(Option.map(Struct.get("value")), Option.getOrUndefined),
        ),
      )

/** The host's connection API, with a scriptable active credential. */
class FakeConnection extends Context.Service<
  FakeConnection,
  {
    /** The connection API the plugin is given. */
    readonly connection: Connection
    /** Make the next lookup of the active connection die. */
    readonly dieNextActive: Effect.Effect<void>
    /** Make the next resolve fail. */
    readonly failNextResolve: Effect.Effect<void>
    /** Hold the next resolve until the returned effect releases it. */
    readonly holdNextResolve: Effect.Effect<Effect.Effect<void>>
    /** How many times the plugin resolved a connection. */
    readonly resolves: Effect.Effect<number>
    /** Make `active` the active connection, or none. */
    readonly setActive: (active: Option.Option<Active>) => Effect.Effect<void>
  }
>()("@martinthommesen/oc-auth/fake-connection.test-support/FakeConnection") {
  /* An API key, or with `env` the environment's key. */
  public static readonly apiKey = (key: string): Option.Option<Active> => {
    if (key === "env") {
      return Option.some({
        connection: { name: "ANTHROPIC_API_KEY", type: "env" as const },
        value: { key, type: "key" as const },
      })
    }

    return Option.some({
      connection: Struct.assign(STORED, { method: "key" as const }),
      value: { key, type: "key" as const },
    })
  }

  /* Another method's OAuth credential for Anthropic. */
  public static readonly foreign = (access: string): Option.Option<Active> =>
    Option.some({
      connection: STORED,
      value: Struct.assign(imported(access, FUTURE_EXPIRY), {
        methodID: asMethodID("foreign"),
      }),
    })

  /* A credential this plugin imported, holding `access`. */
  public static readonly oauth = (
    access: string,
    expires = FUTURE_EXPIRY,
  ): Option.Option<Active> =>
    Option.some({ connection: STORED, value: imported(access, expires) })

  /* The connection API over `initial`, for one test. */
  public static readonly layer = (
    initial: Option.Option<Active>,
  ): Layer.Layer<FakeConnection> =>
    Layer.effect(
      FakeConnection,
      Effect.gen(function* makeConnection() {
        const state: State = {
          active: yield* Ref.make(initial),
          dying: yield* Ref.make(false),
          failing: yield* Ref.make(false),
          held: yield* Ref.make(Option.none<Deferred.Deferred<boolean>>()),
          resolved: yield* Ref.make(FIRST),
        }

        return FakeConnection.of({
          connection: { active: activeOf(state), resolve: resolveOf(state) },
          dieNextActive: Ref.set(state.dying, true),
          failNextResolve: Ref.set(state.failing, true),
          holdNextResolve: Deferred.make<boolean>().pipe(
            Effect.tap((gate) => Ref.set(state.held, Option.some(gate))),
            Effect.map((gate) =>
              Deferred.succeed(gate, true).pipe(Effect.asVoid),
            ),
          ),
          resolves: Ref.get(state.resolved),
          setActive: (next) => Ref.set(state.active, next),
        })
      }),
    )
}

export default FakeConnection
