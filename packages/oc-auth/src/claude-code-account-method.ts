import { Array as Arr, Effect, Option, Schema, Struct } from "effect"
import AccountSelectionError from "./account-selection-error.ts"
import type ClaudeAccount from "./claude-account.ts"
import ClaudeCodeStores from "./claude-code-stores.ts"
import claudeCodeCredential from "./claude-code-credential.ts"
import keys from "./credential-refresh-keys.ts"
import sources from "./claude-code-sources.ts"

type Account = typeof ClaudeAccount.Type

/** The answers to the `/connect` form, as the host passes them. */
type FormAnswer = Readonly<
  Record<string, string | number | boolean | readonly string[]>
>

/** The one field of the account form: which registered account to import. */
interface AccountField {
  readonly key: "account"
  readonly options: readonly {
    readonly label: string
    readonly value: string
  }[]
  readonly required: true
  readonly title: string
  readonly type: "string"
}

const AccountAnswer = Schema.Struct({ account: Schema.NonEmptyString }),
  NO_CREDENTIALS =
    "No Claude Code credentials were found. Run `claude` to authenticate, restart the OpenCode service, and try `/connect` again.",
  SINGLE_ACCOUNT = 1,
  /* A static account form, only when there is more than one account to pick. */
  buildAccountForm = (
    accounts: readonly Account[],
  ): Option.Option<readonly [AccountField]> => {
    if (accounts.length <= SINGLE_ACCOUNT) {
      return Option.none()
    }

    return Option.some([
      {
        key: "account",
        options: accounts.map((account) => ({
          label: account.label,
          value: account.source,
        })),
        required: true,
        title: "Claude Code account",
        type: "string",
      },
    ])
  },
  /*
   * An OpenCode credential for `account`. Importing an account clears any
   * backoff state its store or token carried, terminal state included.
   */
  importAccount = Effect.fn("ClaudeCodeAccountMethod.importAccount")(
    function* importAccount(account: Account) {
      const credential = claudeCodeCredential.fromSource(
          account.credentials,
          Struct.assign(Struct.pick(account, ["configDir", "source"]), {
            accountLabel: account.label,
            sourceTokenHash: yield* sources.tokenFingerprint(
              account.credentials.accessToken,
            ),
          }),
        ),
        subject = yield* keys.subjectOf(credential)

      yield* keys.clearOutcome(subject)

      return claudeCodeCredential.toOAuth(credential)
    },
  ),
  /* Fail `/connect` with `message` for the user. */
  refuse = (message: string): Effect.Effect<never, AccountSelectionError> =>
    Effect.fail(AccountSelectionError.make({ message })),
  /*
   * The `source` of the store the user asked for, or none when there is no
   * account. With several accounts the form must name one; with one, it is
   * that one.
   */
  requestedSource = (
    accounts: readonly Account[],
    answer: FormAnswer,
  ): Effect.Effect<Option.Option<string>, AccountSelectionError> => {
    if (accounts.length > SINGLE_ACCOUNT) {
      return Option.match(Schema.decodeUnknownOption(AccountAnswer)(answer), {
        onNone: () =>
          refuse(
            "No Claude Code account was selected. Select a registered Claude Code account, then try again.",
          ),
        onSome: (answered) => Effect.succeedSome(answered.account),
      })
    }

    return Effect.succeed(
      Arr.head(accounts).pipe(Option.map((account) => account.source)),
    )
  },
  /* The registered account the user asked for. */
  selectedAccount = Effect.fn("ClaudeCodeAccountMethod.selectedAccount")(
    function* selectedAccount(
      accounts: readonly Account[],
      answer: FormAnswer,
    ) {
      const requested = yield* requestedSource(accounts, answer)

      if (Option.isNone(requested)) {
        return yield* refuse(NO_CREDENTIALS)
      }

      return yield* Arr.findFirst(
        accounts,
        (account) => account.source === requested.value,
      ).pipe(
        Option.match({
          onNone: () =>
            refuse(
              "The selected Claude Code account was not registered when the OpenCode service started. Restart the OpenCode service to refresh the account list.",
            ),
          onSome: (account) => Effect.succeed(account),
        }),
      )
    },
  ),
  /*
   * Import the account the user picked from those registered at startup,
   * with what its store holds now. Accounts added after registration are
   * not offered.
   */
  withSelection = Effect.fn("ClaudeCodeAccountMethod.authorize")(
    function* withSelection(accounts: readonly Account[], answer: FormAnswer) {
      const selected = yield* selectedAccount(accounts, answer),
        stores = yield* ClaudeCodeStores,
        tokensNow = yield* stores.readSource(
          selected.source,
          Option.fromUndefinedOr(selected.configDir),
        )

      if (Option.isNone(tokensNow)) {
        return yield* refuse(
          "The selected Claude Code account is no longer available. Restart the OpenCode service to refresh the account list.",
        )
      }

      return yield* importAccount(
        Struct.assign(selected, { credentials: tokensNow.value }),
      )
    },
  )

/** The `/connect` method that imports a Claude Code account. */
export default Object.freeze({
  authorize: withSelection,
  buildAccountForm,
  importAccount,
})
