import { Clock, Effect, Fiber, Option, Ref } from "effect"
import type ClaudeAccount from "./claude-account.ts"
import CredentialRefresh from "./credential-refresh.ts"
import LockAttempt from "./refresh-lock-attempt.ts"
import RefreshRig from "./refresh-rig.test-support.ts"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import TokenExchange from "./token-exchange.ts"
import accountMethod from "./claude-code-account-method.ts"
import claudeCodeCredential from "./claude-code-credential.ts"

type Script = Parameters<typeof RefreshRig.layer>[typeof FIRST]

type Account = typeof ClaudeAccount.Type

type Tokens = Account["credentials"]

type Attempt = ReturnType<(typeof LockAttempt)["Busy" | "Cooldown" | "Held"]>

type Outcome = Effect.Success<ReturnType<TokenExchange["Service"]["exchange"]>>

type Refresh = Effect.Success<
  ReturnType<CredentialRefresh["Service"]["refresh"]>
>

type RefreshError = Effect.Error<
  ReturnType<CredentialRefresh["Service"]["refresh"]>
>

type Asked = Parameters<CredentialRefresh["Service"]["refresh"]>[typeof FIRST]

/** A refresh result reduced to what tests compare. */
interface Summary {
  readonly access: Option.Option<string>
  readonly kind: string
  readonly retryAfterMs: Option.Option<number>
}

const BAD_REQUEST = 400,
  /** Test time starts here, so a token can expire before it. */
  BASE_TIME = 1_000_000,
  FIRST = 0,
  HOUR_MS = 3_600_000,
  /** Long enough for the wait for another process's credential to give up. */
  POLL_BUDGET_MS = 6000,
  PRIMARY = "Claude Code-credentials",
  RATE_LIMITED = 429,
  SERVER_ERROR = 503,
  SETTLE_YIELDS = 20,
  /*
   * A registered account in `source`, holding `accessToken`. `source` must be
   * a real Keychain service name or `file`: credential metadata is validated
   * on the way back in, so an arbitrary name would not round-trip.
   */
  account = (source = PRIMARY, accessToken = "old-access"): Account => ({
    configDir: `/claude/${source}`,
    credentials: {
      accessToken,
      expiresAt: BASE_TIME + HOUR_MS,
      refreshToken: "old-refresh",
      subscriptionType: "pro",
    },
    label: `Claude Pro: ${source}`,
    source,
  }),
  /* Ask the refresh service to adopt for `credential`. */
  adopt = (
    credential: Asked,
  ): Effect.Effect<Refresh, never, CredentialRefresh> =>
    CredentialRefresh.pipe(
      Effect.flatMap((service) => service.adopt(credential)),
    ),
  /* Set the test clock to the base time. */
  begin = TestClock.setTime(BASE_TIME),
  /* The lock busy in another process. */
  busy: Effect.Effect<Attempt> = Effect.succeed(LockAttempt.Busy()),
  /* Another process cooling down until `until`. */
  cooldownUntil = (until: number): Effect.Effect<Attempt> =>
    Effect.succeed(LockAttempt.Cooldown({ until })),
  /* The host credential a result carries, if any. */
  credentialAfter = (result: Refresh): Option.Option<Asked> =>
    CredentialRefresh.Result.$match(result, {
      Adopted: ({ credential }) =>
        Option.some(claudeCodeCredential.toOAuth(credential)),
      Refreshed: ({ credential }) =>
        Option.some(claudeCodeCredential.toOAuth(credential)),
      Transient: () => Option.none(),
      Unchanged: () => Option.none(),
    }),
  /* The rig the current test runs against. */
  currentRig: Effect.Effect<RefreshRig["Service"], never, RefreshRig> =
    RefreshRig,
  /* What the store holds now. */
  currentlyStored = currentRig.pipe(
    Effect.flatMap((rig) => Ref.get(rig.stored)),
  ),
  /* The lock held by this process, extending when asked only if `extend`. */
  heldLock = (
    extend: boolean,
  ): Effect.Effect<Attempt, never, RefreshRig | Scope.Scope> =>
    Effect.acquireRelease(
      currentRig.pipe(
        Effect.map((rig) =>
          LockAttempt.Held({
            lock: {
              defer: (ms) =>
                Ref.update(rig.lockEvents, (events) => [
                  ...events,
                  `defer:${ms}`,
                ]),
              degraded: false,
              extend: () => Effect.succeed(extend),
              release: Effect.void,
            },
          }),
        ),
      ),
      () =>
        currentRig.pipe(
          Effect.flatMap((rig) =>
            Ref.update(rig.lockEvents, (events) => [...events, "release"]),
          ),
        ),
    ),
  /* Make the store hold `tokens`, as when another process rotates them. */
  holdInStore = (
    tokens: Option.Option<Tokens>,
  ): Effect.Effect<void, never, RefreshRig> =>
    currentRig.pipe(Effect.flatMap((rig) => Ref.set(rig.stored, tokens))),
  /* The token endpoint rejecting the refresh token for good. */
  invalidGrant: Effect.Effect<Outcome> = Effect.succeed(
    TokenExchange.Outcome.Terminal({
      oauthError: Option.some("invalid_grant"),
      status: BAD_REQUEST,
    }),
  ),
  /* The token endpoint issuing `accessToken`, valid for an hour. */
  issued = (accessToken: string): Effect.Effect<Outcome> =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) =>
        TokenExchange.Outcome.Ok({
          credentials: {
            accessToken,
            expiresAt: now + HOUR_MS,
            refreshToken: "new-refresh",
          },
        }),
      ),
    ),
  /* Run `effect` to completion, letting the wait for another process run out. */
  polled = <Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>,
  ): Effect.Effect<Value, Failure, Requirements> =>
    Effect.forkChild(effect).pipe(
      Effect.tap(() => TestClock.adjust(POLL_BUDGET_MS)),
      Effect.flatMap((fiber) => Fiber.join(fiber)),
    ),
  /* The token endpoint rate limiting, with `retryAfterMs` as its hint. */
  rateLimited = (retryAfterMs: Option.Option<number>): Effect.Effect<Outcome> =>
    Effect.succeed(
      TokenExchange.Outcome.Transient({
        oauthError: Option.some("rate_limit_error"),
        retryAfterMs,
        status: RATE_LIMITED,
      }),
    ),
  /* Ask the refresh service to refresh `credential`. */
  refresh = (
    credential: Asked,
  ): Effect.Effect<Refresh, RefreshError, CredentialRefresh> =>
    CredentialRefresh.pipe(
      Effect.flatMap((service) => service.refresh(credential)),
    ),
  /* Fakes that answer as a healthy store, lock, and endpoint would. */
  script: Script = {
    acquire: heldLock(true),
    exchange: () => issued("new-access"),
    read: () => currentlyStored,
    writeBack: () => Effect.succeed("written"),
  },
  /* The token endpoint failing with a 503 and no OAuth error. */
  serverError: Effect.Effect<Outcome> = Effect.succeed(
    TokenExchange.Outcome.Transient({
      oauthError: Option.none(),
      retryAfterMs: Option.none(),
      status: SERVER_ERROR,
    }),
  ),
  /* Let forked fibers run until they wait on something. */
  settle = Effect.yieldNow.pipe(Effect.repeat({ times: SETTLE_YIELDS })),
  /* `result` reduced to its kind, access token, and suggested wait. */
  summary = (result: Refresh): Summary =>
    CredentialRefresh.Result.$match(result, {
      Adopted: ({ credential }) => ({
        access: Option.some(credential.access),
        kind: "adopted",
        retryAfterMs: Option.none(),
      }),
      Refreshed: ({ credential }) => ({
        access: Option.some(credential.access),
        kind: "refreshed",
        retryAfterMs: Option.none(),
      }),
      Transient: ({ retryAfterMs }) => ({
        access: Option.none(),
        kind: "transient",
        retryAfterMs: Option.some(retryAfterMs),
      }),
      Unchanged: () => ({
        access: Option.none(),
        kind: "unchanged",
        retryAfterMs: Option.none(),
      }),
    }),
  /* Tokens as a store holds them, expiring at `expiresAt`. */
  tokens = (
    accessToken: string,
    refreshToken = "old-refresh",
    expiresAt = BASE_TIME + HOUR_MS,
  ): Tokens => ({ accessToken, expiresAt, refreshToken })

/** What the credential refresh tests share. */
export default Object.freeze({
  BASE_TIME,
  PRIMARY,
  account,
  adopt,
  begin,
  busy,
  cooldownUntil,
  credentialAfter,
  currentRig,
  heldLock,
  holdInStore,
  imported: accountMethod.importAccount,
  invalidGrant,
  issued,
  polled,
  rateLimited,
  refresh,
  script,
  serverError,
  settle,
  summary,
  tokens,
})
