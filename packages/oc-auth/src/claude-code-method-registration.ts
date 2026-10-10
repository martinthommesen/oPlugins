import { Effect, Exit, Option } from "effect"
import ActiveCredential from "./active-credential.ts"
import type ClaudeAccount from "./claude-account.ts"
import type ClaudeCodeStoreError from "./claude-code-store-error.ts"
import CredentialRefresh from "./credential-refresh.ts"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import type { Plugin } from "@opencode/plugin/effect"
import accountMethod from "./claude-code-account-method.ts"
import claudeCodeCredential from "./claude-code-credential.ts"

/** The part of the host's integration editor that registration uses. */
interface MethodEditor {
  readonly method: {
    readonly update: (registration: IntegrationOAuthMethodRegistration) => void
  }
}

/** The host's integration transform, as registration calls it. */
type Transform = (
  callback: (editor: MethodEditor) => void,
) => ReturnType<Plugin.Context["integration"]["transform"]>

type Accounts = readonly (typeof ClaudeAccount.Type)[]

type Discovery = Exit.Exit<Accounts, ClaudeCodeStoreError>

type Form = ReturnType<typeof accountMethod.buildAccountForm>

/** The parts of an OpenCode credential the refresh callback reads. */
type HostCredential = Readonly<
  Parameters<CredentialRefresh["Service"]["refresh"]>[typeof FIRST]
>

type ClaudeCodeCredential = ReturnType<typeof claudeCodeCredential.fromSource>

/*
 * The host's OAuth credential as the callbacks read it, read-only. The
 * readonly rule flags `metadata` and the branded `methodID` together, though
 * neither is writable here, and nothing reads `methodID`.
 */
type HostOAuth = Readonly<
  Pick<
    ReturnType<typeof claudeCodeCredential.toOAuth>,
    "access" | "expires" | "metadata" | "refresh" | "type"
  >
>

/** What the `/connect` method uses, captured once for its callbacks. */
type Method =
  | ActiveCredential
  | CredentialRefresh
  | Effect.Services<ReturnType<typeof accountMethod.authorize>>

const FIRST = 0,
  INSTRUCTIONS = "Claude Code credentials imported from this device.",
  LABEL = "Import Claude Code subscription",
  NONE = 0,
  SECOND = 1,
  /*
   * Use `next` in place of the credential the host asked to refresh, and
   * hand the host the credential to store.
   */
  adoptNext = (
    previous: HostCredential,
    next: ClaudeCodeCredential,
  ): Effect.Effect<
    ReturnType<typeof claudeCodeCredential.toOAuth>,
    never,
    ActiveCredential
  > =>
    ActiveCredential.pipe(
      Effect.flatMap((active) =>
        Option.match(claudeCodeCredential.fromOAuth(previous), {
          onNone: () => Effect.void,
          onSome: (current) => active.swap(current, next),
        }),
      ),
      Effect.as(claudeCodeCredential.toOAuth(next)),
    ),
  /* The host's credential back as it came, for a refresh that kept it. */
  asHost = (
    credential: HostCredential,
  ): ReturnType<typeof claudeCodeCredential.toOAuth> => ({
    access: credential.access,
    expires: credential.expires,
    metadata: credential.metadata,
    methodID: claudeCodeCredential.METHOD_ID,
    refresh: credential.refresh,
    type: "oauth",
  }),
  /*
   * Import the account the user picked. A startup discovery failure (a
   * locked Keychain, say) is reported here instead of claiming that no
   * credentials exist.
   */
  authorizeWith = (
    accounts: Accounts,
    discovery: Discovery,
    answer: Parameters<typeof accountMethod.authorize>[typeof SECOND],
  ): Effect.Effect<
    {
      readonly callback: ReturnType<
        typeof Effect.succeed<ReturnType<typeof claudeCodeCredential.toOAuth>>
      >
      readonly instructions: string
      readonly mode: "auto"
      readonly url: string
    },
    | ClaudeCodeStoreError
    | Effect.Error<ReturnType<typeof accountMethod.authorize>>,
    Method
  > => {
    if (accounts.length === NONE && Exit.isFailure(discovery)) {
      return Effect.failCause(discovery.cause)
    }

    return Effect.gen(function* importSelected() {
      const credential = yield* accountMethod.authorize(accounts, answer)

      return {
        callback: Effect.succeed(credential),
        instructions: INSTRUCTIONS,
        mode: "auto" as const,
        url: "",
      }
    })
  },
  /*
   * The host's refresh callback, kept in step with the request path: the
   * credential it returns is the one requests use from then on.
   */
  hostRefresh = Effect.fn("ClaudeCodeMethod.refresh")(function* hostRefresh(
    credential: HostCredential,
  ) {
    const refresh = yield* CredentialRefresh,
      result = yield* refresh.refresh(credential)

    return yield* CredentialRefresh.Result.$match(result, {
      Adopted: ({ credential: next }) => adoptNext(credential, next),
      Refreshed: ({ credential: next }) => adoptNext(credential, next),
      Transient: () => Effect.succeed(asHost(credential)),
      Unchanged: () => Effect.succeed(asHost(credential)),
    })
  }),
  /* The OAuth method, with an account form only for several accounts. */
  methodFor = (
    form: Form,
  ): Parameters<Transform>[typeof FIRST] extends never
    ? never
    : {
        readonly form?: Option.Option.Value<Form>
        readonly id: string
        readonly label: string
        readonly type: "oauth"
      } =>
    Option.match(form, {
      onNone: () => ({
        id: "claude-code",
        label: LABEL,
        type: "oauth" as const,
      }),
      onSome: (fields) => ({
        form: fields,
        id: "claude-code",
        label: LABEL,
        type: "oauth" as const,
      }),
    }),
  /*
   * Register the `/connect` method that imports a Claude Code account, over
   * the accounts discovered at startup.
   */
  wire = Effect.fn("ClaudeCodeMethod.register")(function* wire(
    transform: Transform,
    discovery: Discovery,
  ) {
    const accounts = Exit.match(discovery, {
        onFailure: (): Accounts => [],
        onSuccess: (found) => found,
      }),
      context = yield* Effect.context<Method>()

    yield* transform((editor) => {
      editor.method.update({
        authorize: (answer) =>
          authorizeWith(accounts, discovery, answer).pipe(
            Effect.provideContext(context),
          ),
        integrationID: claudeCodeCredential.INTEGRATION_ID,
        label: (credential: HostOAuth) =>
          claudeCodeCredential.credentialLabel(credential),
        method: methodFor(accountMethod.buildAccountForm(accounts)),
        refresh: (credential: HostOAuth) =>
          hostRefresh(credential).pipe(Effect.provideContext(context)),
      })
    })
  })

/** The `/connect` method that imports a Claude Code subscription. */
export default Object.freeze({ register: wire })
