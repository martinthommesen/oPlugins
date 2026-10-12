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
  /** The leader's outcome, which every joiner awaits. */
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
  /* Claim the store of `subject` with `entry`, or the leader that holds it. */
  claimStore = (
    state: State,
    subject: Subject,
    entry: InFlight,
  ): Effect.Effect<Option.Option<InFlight>> =>
    Ref.modify(
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
    ),
  /*
   * The leader's `credential` with the joiner's own metadata, so the joiner
   * keeps its label and takes only the leader's fingerprint of the store.
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
      Transient: (): Refresh => result,
      Unchanged: (): Refresh => result,
    }),
  /*
   * Start refreshing `subject` as the leader for its store, `entry` already
   * claimed. The refresh runs in the service's scope, so a leader whose
   * caller goes away does not take its joiners' result down with it. Only
   * the leader removes its entry, so the store still maps to `entry` when it
   * ends.
   */
  lead = Effect.fn("CredentialRefresh.lead")(function* lead(
    state: State,
    subject: Subject,
    entry: InFlight,
  ) {
    yield* run.performRefresh(subject).pipe(
      Effect.onExit((exit) =>
        Ref.update(state.inFlight, HashMap.remove(subject.sourceKey)).pipe(
          Effect.andThen(Deferred.done(entry.result, exit)),
        ),
      ),
      Effect.forkIn(state.scope),
    )
  }),
  /*
   * Claim the store of `subject` with `entry` and start leading its
   * refresh, or the leader that already holds it. Claiming and starting
   * cannot be interrupted apart, so an interrupted caller never leaves
   * joiners awaiting a claim that no leader will settle.
   */
  leadUnlessHeld = (
    state: State,
    subject: Subject,
    entry: InFlight,
  ): Effect.Effect<Option.Option<InFlight>, never, Requirements> =>
    claimStore(state, subject, entry).pipe(
      Effect.tap(
        Option.match({
          onNone: () => lead(state, subject, entry),
          onSome: () => Effect.void,
        }),
      ),
      Effect.uninterruptible,
    ),
  /*
   * After the leader's refresh token was rejected: a joiner of the same
   * credential generation fails too, and one holding a newer generation gets
   * none, so it asks again with its own refresh token.
   */
  newerGeneration = Effect.fn("CredentialRefresh.newerGeneration")(
    function* newerGeneration(subject: Subject, leaderKey: string) {
      if (leaderKey === subject.credentialKey) {
        return yield* ClaudeAuthTerminalError.make({
          message: ClaudeAuthTerminalError.text,
        })
      }

      return Option.none<Refresh>()
    },
  ),
  /*
   * The result of the refresh `leader` is running for the store of
   * `subject`, or none when `subject` has to ask again.
   */
  onLeader = Effect.fn("CredentialRefresh.join")(function* onLeader(
    subject: Subject,
    leader: InFlight,
  ) {
    return yield* Deferred.await(leader.result).pipe(
      Effect.map((result) => Option.some(forJoiner(result, subject))),
      Effect.catchTag("ClaudeAuthTerminalError", () =>
        newerGeneration(subject, leader.credentialKey),
      ),
    )
  }),
  /*
   * Join the refresh in flight for the store of `subject`, or lead one.
   * A joiner that has to ask again, after the leader's refresh token was
   * rejected, joins whichever refresh another such joiner started first.
   * Only the wait for the result can be interrupted.
   */
  shareRefresh = Effect.fn("CredentialRefresh.shareRefresh")(
    // A generator named `shareRefresh` would retry by recursing into itself, not into the Effect.
    function* claimOrJoin(
      state: State,
      subject: Subject,
    ): Effect.fn.Return<Refresh, RefreshError, Requirements> {
      const entry = yield* entryFor(subject),
        leader = yield* leadUnlessHeld(state, subject, entry),
        shared = yield* Option.match(leader, {
          // The caller that leads awaits the refresh it started.
          onNone: () => Deferred.await(entry.result).pipe(Effect.asSome),
          onSome: (current) => onLeader(subject, current),
        })

      return yield* Option.match(shared, {
        onNone: () => shareRefresh(state, subject),
        onSome: (result) => Effect.succeed(result),
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
