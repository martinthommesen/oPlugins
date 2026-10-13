import {
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Redacted,
  Schema,
  flow,
} from "effect"
import HostError from "./host-error.ts"
import type { Plugin } from "@opencode/plugin/effect"

type Connection = Plugin.Context["integration"]["connection"]

/** The parts of the host's plugin context this service reads. */
interface HostContext {
  readonly integration: {
    readonly connection: Pick<Connection, "active" | "resolve">
  }
}

/** An OAuth sign-in's access token, and the account its metadata names. */
interface Access {
  /** The ChatGPT account the credential's metadata names, if it names one. */
  readonly accountId: Option.Option<string>
  readonly token: Redacted.Redacted
}

/** The active connection of one integration. */
interface SignIn {
  /**
   * The connection's OAuth access token, which the host renews first when
   * it's about to expire. None when the connection holds an API key or
   * another credential that isn't an OAuth sign-in.
   */
  readonly access: Effect.Effect<Option.Option<Access>, HostError>
  /** Tells the connection's account apart from every other's. */
  readonly identity: string
}

interface Interface {
  /** The integration's active connection, if it has one. */
  readonly signIn: (
    integrationId: string,
  ) => Effect.Effect<Option.Option<SignIn>, HostError>
}

/* A connection, as far as telling it apart from another goes. */
const ConnectionKey = Schema.Union([
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      type: Schema.Literal("credential"),
    }),
    Schema.Struct({ name: Schema.String, type: Schema.Literal("env") }),
  ]),
  /** The metadata of OpenCode's ChatGPT sign-in, which names the account. */
  Metadata = Schema.Struct({ accountID: Schema.NonEmptyString }),
  /** An OAuth credential, decoded to the parts this plugin reads. */
  OAuthCredential = Schema.Struct({
    access: Schema.NonEmptyString,
    metadata: Schema.optionalKey(Schema.Unknown),
    type: Schema.Literal("oauth"),
  }),
  OtherKind = Schema.String.check(
    Schema.makeFilter((value) => value !== "oauth"),
  ),
  ResolvedCredential = Schema.Union([
    OAuthCredential,
    Schema.Struct({
      type: OtherKind,
    }),
  ]),
  decodeKey = Schema.decodeUnknownEffect(ConnectionKey),
  decodeMetadata = Schema.decodeUnknownOption(Metadata),
  decodeOAuth = flow(
    Schema.decodeUnknownEffect(ResolvedCredential),
    HostError.during("integration.connection.decode"),
  ),
  /* The access an OAuth credential grants. */
  grantedAccess = (oauth: typeof OAuthCredential.Type): Access => ({
    accountId: decodeMetadata(oauth.metadata).pipe(
      Option.map((metadata) => metadata.accountID),
    ),
    token: Redacted.make(oauth.access),
  }),
  /*
   * A connection's identity: a stored credential's ID and label, which
   * changes with the account, or an environment variable's name.
   */
  identityOf = (key: typeof ConnectionKey.Type): string =>
    Match.value(key).pipe(
      Match.discriminators("type")({
        credential: (credential) =>
          `credential:${credential.id}:${credential.label}`,
        env: (variable) => `env:${variable.name}`,
      }),
      Match.exhaustive,
    )

/** What the plugin reads from the host: the active connections. */
class Host extends Context.Service<Host, Interface>()(
  "@martinthommesen/oc-usage/host",
) {
  /* The host service, reading through the plugin context. */
  public static readonly fromPlugin = (
    context: HostContext,
  ): Layer.Layer<Host> =>
    Layer.succeed(
      Host,
      Host.of({
        signIn: Effect.fn("Host.signIn")(function* signIn(
          integrationId: string,
        ) {
          const { connection } = context.integration,
            // The host reports a problem with the active connection as a defect.
            active = yield* connection
              .active(integrationId)
              .pipe(
                Effect.catchDefect(
                  HostError.failing("integration.connection.active"),
                ),
              )

          if (Predicate.isNotUndefined(active)) {
            // The host's call fails with `unknown`, mapped to a `HostError` naming the call.
            const access: SignIn["access"] = connection.resolve(active).pipe(
              HostError.during("integration.connection.resolve"),
              Effect.flatMap(decodeOAuth),
              Effect.map((credential) =>
                Option.liftPredicate(
                  credential,
                  Schema.is(OAuthCredential),
                ).pipe(Option.map(grantedAccess)),
              ),
            )

            return yield* decodeKey(active).pipe(
              Effect.map((key) =>
                Option.some({ access, identity: identityOf(key) }),
              ),
              HostError.during("integration.connection.decode"),
            )
          }

          return Option.none<SignIn>()
        }),
      }),
    )
}

export default Host
