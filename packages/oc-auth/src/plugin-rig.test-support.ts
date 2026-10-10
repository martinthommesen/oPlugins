import { Context, Effect, Layer, Option, Ref } from "effect"
import AnthropicFetch from "./anthropic-fetch.ts"
import type AnthropicFetchError from "./anthropic-fetch-error.ts"
import type ClaudeAccount from "./claude-account.ts"
import type ClaudeCodeStoreError from "./claude-code-store-error.ts"
import ClaudeCodeStores from "./claude-code-stores.ts"
import CredentialRefresh from "./credential-refresh.ts"
import claudeCodeCredential from "./claude-code-credential.ts"

type Refresh = Effect.Success<
  ReturnType<CredentialRefresh["Service"]["refresh"]>
>

type RefreshError = Effect.Error<
  ReturnType<CredentialRefresh["Service"]["refresh"]>
>

type Accounts = readonly (typeof ClaudeAccount.Type)[]

/** How the fake stores, refresh service, and API answer, by call number. */
interface PluginScript {
  readonly accounts: Effect.Effect<Accounts, ClaudeCodeStoreError>
  readonly adopt: (call: number) => Effect.Effect<Refresh>
  readonly fetch: (call: number) => Effect.Effect<Response, AnthropicFetchError>
  readonly refresh: (call: number) => Effect.Effect<Refresh, RefreshError>
}

/** What the rig counts and records. */
interface Tally {
  readonly adopts: Ref.Ref<number>
  readonly refreshes: Ref.Ref<number>
  readonly sent: Ref.Ref<readonly Request[]>
}

const ONE = 1,
  ZERO = 0,
  /* Count one more call on `counter`, and the call's number. */
  countCall = (counter: Ref.Ref<number>): Effect.Effect<number> =>
    Ref.updateAndGet(counter, (count) => count + ONE),
  /* The fake stores, refresh service, and API over `tally`, per `script`. */
  fakes = (
    tally: Tally,
    script: PluginScript,
    accounts: Accounts,
  ): Context.Context<AnthropicFetch | ClaudeCodeStores | CredentialRefresh> =>
    Context.make(
      AnthropicFetch,
      AnthropicFetch.of({
        send: (request) =>
          Ref.updateAndGet(tally.sent, (sent) => [...sent, request]).pipe(
            Effect.flatMap((sent) => script.fetch(sent.length)),
          ),
      }),
    ).pipe(
      Context.add(
        ClaudeCodeStores,
        ClaudeCodeStores.of({
          readAccounts: script.accounts,
          readSource: (source) =>
            Effect.succeed(
              Option.fromUndefinedOr(
                accounts.find((account) => account.source === source),
              ).pipe(Option.map((account) => account.credentials)),
            ),
          writeBack: () => Effect.die("write-back is not scripted"),
        }),
      ),
      Context.add(
        CredentialRefresh,
        CredentialRefresh.of({
          adopt: () =>
            countCall(tally.adopts).pipe(Effect.flatMap(script.adopt)),
          refresh: () =>
            countCall(tally.refreshes).pipe(Effect.flatMap(script.refresh)),
        }),
      ),
    )

/** The services behind the plugin, scripted, recording how they were used. */
class PluginRig extends Context.Service<
  PluginRig,
  {
    readonly adopts: Effect.Effect<number>
    readonly refreshes: Effect.Effect<number>
    /** The requests replayed, in order. */
    readonly sent: Effect.Effect<readonly Request[]>
  }
>()("@martinthommesen/oc-auth/plugin-rig.test-support/PluginRig") {
  /* A credential this plugin imported from the primary store, holding `access`. */
  public static readonly credential = (
    access: string,
  ): ReturnType<typeof claudeCodeCredential.fromSource> =>
    claudeCodeCredential.fromSource(
      {
        accessToken: access,
        expiresAt: Number.MAX_SAFE_INTEGER,
        refreshToken: `refresh-${access}`,
      },
      {
        accountLabel: "Claude Pro: Claude Code-credentials",
        source: "Claude Code-credentials",
        sourceTokenHash: "fingerprint",
      },
    )

  /* The fakes per `script`, with `accounts` registered in the stores. */
  public static readonly layer = (
    script: PluginScript,
    accounts: Accounts,
  ): Layer.Layer<
    AnthropicFetch | ClaudeCodeStores | CredentialRefresh | PluginRig
  > =>
    Layer.effectContext(
      Effect.gen(function* makeRig() {
        const recorded: Tally = {
            adopts: yield* Ref.make(ZERO),
            refreshes: yield* Ref.make(ZERO),
            sent: yield* Ref.make<readonly Request[]>([]),
          },
          rig = PluginRig.of({
            adopts: Ref.get(recorded.adopts),
            refreshes: Ref.get(recorded.refreshes),
            sent: Ref.get(recorded.sent),
          })

        return fakes(recorded, script, accounts).pipe(
          Context.add(PluginRig, rig),
        )
      }),
    )

  /* A healthy rig: nothing to adopt or refresh, and no replay expected. */
  public static readonly quiet: PluginScript = {
    accounts: Effect.succeed([]),
    adopt: () => Effect.succeed(CredentialRefresh.Result.Unchanged()),
    fetch: () => Effect.die("no replay was expected"),
    refresh: () => Effect.succeed(CredentialRefresh.Result.Unchanged()),
  }
}

export default PluginRig
