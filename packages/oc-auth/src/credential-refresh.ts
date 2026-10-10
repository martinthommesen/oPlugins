import {
  Context,
  Deferred,
  Effect,
  HashMap,
  Layer,
  Option,
  Ref,
  Struct,
} from "effect"
import ClaudeAuthTerminalError from "./claude-auth-terminal-error.ts"
import type { Credential } from "@opencode/plugin/effect"
import RefreshResult from "./credential-refresh-result.ts"
import type { Scope } from "effect"
import adoption from "./credential-adoption.ts"
import claudeCodeCredential from "./claude-code-credential.ts"
import keys from "./credential-refresh-keys.ts"
import run from "./credential-refresh-run.ts"

type Subject = Effect.Success<ReturnType<typeof keys.subjectOf>>

type Refresh = Effect.Success<ReturnType<typeof run.performRefresh>>

type RefreshError = Effect.Error<ReturnType<typeof run.performRefresh>>

type ClaudeCodeCredential = Subject["credential"]

/** The parts of an OpenCode credential a refresh reads. */
type OAuthParts = Pick<
  Credential.OAuth,
  "access" | "expires" | "metadata" | "refresh"
>

/** What adopting and refreshing need from the platform and the other services. */
type Requirements =
  | Effect.Services<ReturnType<typeof adoption.adoptExternal>>
  | Effect.Services<ReturnType<typeof keys.subjectOf>>
  | Exclude<Effect.Services<ReturnType<typeof run.performRefresh>>, Scope.Scope>

/** A refresh in progress for one store, which callers for that store join. */
interface InFlight {
  /** The credential generation the leader is refreshing. */
  readonly credentialKey: string
  readonly result: Deferred.Deferred<Refresh, RefreshError>
}

/** The state one refresh service owns for the plugin's lifetime. */
interface State {
  /** In-flight refreshes by store. */
  readonly inFlight: Ref.Ref<HashMap.HashMap<string, InFlight>>
  /** Where leaders run, so a refresh completes even when its caller goes away. */
  readonly scope: Scope.Scope
}

/* `credential` as the subject of a refresh, or none when it is not ours. */
const aboutCredential = (
    credential: OAuthParts,
  ): Effect.Effect<Option.Option<Subject>, never, Requirements> =>
    Option.match(claudeCodeCredential.fromOAuth(credential), {
      onNone: () => Effect.succeedNone,
      onSome: (ours) => keys.subjectOf(ours).pipe(Effect.asSome),
    }),
  /* Adopt a credential rotated outside OpenCode, if one is there. */
  adoptCredential = Effect.fn("CredentialRefresh.adopt")(
    function* adoptCredential(credential: OAuthParts) {
      return yield* Option.match(yield* aboutCredential(credential), {
        onNone: () => Effect.succeed<Refresh>(RefreshResult.Unchanged()),
        onSome: (subject) => adoption.adoptExternal(subject),
      })
    },
  ),
  /*
   * The leader's `credential`, carrying the joiner's own metadata: its label
   * stays, and only the fingerprint of what the store holds comes along.
   */
  credentialForJoiner = (
    credential: ClaudeCodeCredential,
    subject: Subject,
  ): ClaudeCodeCredential =>
    Struct.assign(credential, {
      metadata: claudeCodeCredential.withSourceTokenHash(
        subject.credential.metadata,
        credential.metadata.sourceTokenHash,
      ),
    }),
  /* A fresh in-flight entry for a refresh of `subject`. */
  entryFor = (subject: Subject): Effect.Effect<InFlight> =>
    Deferred.make<Refresh, RefreshError>().pipe(
      Effect.map((result) => ({
        credentialKey: subject.credentialKey,
        result,
      })),
    ),
  /* The leader's `result`, as it applies to the joiner `subject`. */
  forJoiner = (result: Refresh, subject: Subject): Refresh =>
    RefreshResult.$match(result, {
      Adopted: ({ credential }): Refresh =>
        RefreshResult.Adopted({
          credential: credentialForJoiner(credential, subject),
        }),
      Refreshed: ({ credential }): Refresh =>
        RefreshResult.Refreshed({
          credential: credentialForJoiner(credential, subject),
        }),
      Transient: ({ retryAfterMs }): Refresh =>
        RefreshResult.Transient({ retryAfterMs }),
      Unchanged: (): Refresh => RefreshResult.Unchanged(),
    }),
  /* `inFlight` without `entry`, unless another refresh replaced it already. */
  forget = (
    inFlight: HashMap.HashMap<string, InFlight>,
    sourceKey: string,
    entry: InFlight,
  ): HashMap.HashMap<string, InFlight> => {
    if (
      Option.exists(
        HashMap.get(inFlight, sourceKey),
        (current) => current.result === entry.result,
      )
    ) {
      return HashMap.remove(inFlight, sourceKey)
    }

    return inFlight
  },
  /*
   * Refresh `subject` as the leader for its store. The refresh runs in the
   * service's scope, like the shared promise it replaces: a caller that
   * goes away does not take it, or its joiners' result, down with it.
   */
  lead = Effect.fn("CredentialRefresh.lead")(function* lead(
    state: State,
    subject: Subject,
    entry: InFlight,
  ) {
    yield* Ref.update(state.inFlight, HashMap.set(subject.sourceKey, entry))
    yield* run.performRefresh(subject).pipe(
      Effect.onExit((exit) =>
        Ref.update(state.inFlight, (inFlight) =>
          forget(inFlight, subject.sourceKey, entry),
        ).pipe(Effect.andThen(Deferred.done(entry.result, exit))),
      ),
      Effect.forkIn(state.scope),
    )

    return yield* Deferred.await(entry.result)
  }),
  /*
   * A terminal outcome is about the leader's refresh token. A joiner
   * holding a newer generation of the same source still has its own.
   */
  newerGeneration = Effect.fn("CredentialRefresh.newerGeneration")(
    function* newerGeneration(
      state: State,
      subject: Subject,
      leaderKey: string,
    ) {
      const entry = yield* entryFor(subject)

      if (leaderKey === subject.credentialKey) {
        return yield* new ClaudeAuthTerminalError({
          message: ClaudeAuthTerminalError.text,
        })
      }

      return yield* lead(state, subject, entry)
    },
  ),
  /* Join the refresh `leader` is running for the store of `subject`. */
  onLeader = Effect.fn("CredentialRefresh.join")(function* onLeader(
    state: State,
    subject: Subject,
    leader: InFlight,
  ) {
    return yield* Deferred.await(leader.result).pipe(
      Effect.map((result) => forJoiner(result, subject)),
      Effect.catchTag("ClaudeAuthTerminalError", () =>
        newerGeneration(state, subject, leader.credentialKey),
      ),
    )
  }),
  /* Join the refresh in flight for the store of `subject`, or lead one. */
  shareRefresh = Effect.fn("CredentialRefresh.shareRefresh")(
    function* shareRefresh(state: State, subject: Subject) {
      const entry = yield* entryFor(subject),
        leader = yield* Ref.modify(
          state.inFlight,
          (
            inFlight,
          ): readonly [
            Option.Option<InFlight>,
            HashMap.HashMap<string, InFlight>,
          ] =>
            Option.match(HashMap.get(inFlight, subject.sourceKey), {
              onNone: () => [
                Option.none(),
                HashMap.set(inFlight, subject.sourceKey, entry),
              ],
              onSome: (current) => [Option.some(current), inFlight],
            }),
        )

      return yield* Option.match(leader, {
        onNone: () => lead(state, subject, entry),
        onSome: (current) => onLeader(state, subject, current),
      })
    },
  ),
  /* Refresh `credential`, sharing one refresh per store between callers. */
  withInFlight = Effect.fn("CredentialRefresh.refresh")(function* withInFlight(
    state: State,
    credential: OAuthParts,
  ) {
    return yield* Option.match(yield* aboutCredential(credential), {
      onNone: () => Effect.succeed<Refresh>(RefreshResult.Unchanged()),
      onSome: (subject) => shareRefresh(state, subject),
    })
  })

/**
 * Keeps OpenCode's copy of a Claude Code credential current: adopts what
 * Claude Code rotated outside OpenCode, and refreshes it through the token
 * endpoint, one refresh per store at a time across callers and processes.
 * Adopted and refreshed credentials come back as `Adopted` and `Refreshed`;
 * `Unchanged` and `Transient` mean the caller keeps its own.
 */
class CredentialRefresh extends Context.Service<
  CredentialRefresh,
  {
    /** Adopt a credential rotated outside OpenCode, if one is there; never fails. */
    readonly adopt: (credential: OAuthParts) => Effect.Effect<Refresh>
    /** Adopt or refresh `credential`, joining a refresh of its store in flight. */
    readonly refresh: (
      credential: OAuthParts,
    ) => Effect.Effect<Refresh, RefreshError>
  }
>()("@martinthommesen/oc-auth/credential-refresh/CredentialRefresh") {
  /** Builds and matches the results of `adopt` and `refresh`. */
  public static readonly Result = RefreshResult

  /** The refresh service, its in-flight refreshes living as long as the layer. */
  public static readonly layer: Layer.Layer<
    CredentialRefresh,
    never,
    Requirements
  > = Layer.effect(
    CredentialRefresh,
    Effect.gen(function* makeCredentialRefresh() {
      const context = yield* Effect.context<Requirements>(),
        state: State = {
          inFlight: yield* Ref.make(HashMap.empty<string, InFlight>()),
          scope: yield* Effect.scope,
        }

      return CredentialRefresh.of({
        adopt: (credential) =>
          adoptCredential(credential).pipe(Effect.provideContext(context)),
        refresh: (credential) =>
          withInFlight(state, credential).pipe(Effect.provideContext(context)),
      })
    }),
  )
}

export default CredentialRefresh
