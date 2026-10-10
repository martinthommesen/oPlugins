import type ClaudeCredentials from "./claude-credentials.ts"
import { Option } from "effect"

/** What one account's label is built from. */
interface LabelSource {
  readonly credentials: typeof ClaudeCredentials.Type
  /** The account's email, which identifies it best. */
  readonly email: Option.Option<string>
  /** Where the account is stored, for when its email is unknown. */
  readonly source: Option.Option<string>
}

const FIRST = 0,
  NEXT = 1,
  REST = 1,
  SINGLE = 1,
  /* `Claude <Tier>` from the subscription type, or `Claude` without one. */
  baseLabel = (credentials: typeof ClaudeCredentials.Type): string =>
    Option.fromUndefinedOr(credentials.subscriptionType).pipe(
      Option.filter((tier) => tier !== ""),
      Option.match({
        onNone: () => "Claude",
        onSome: (tier) =>
          `Claude ${tier.charAt(FIRST).toUpperCase()}${tier.slice(REST)}`,
      }),
    ),
  /* Present and not empty: an empty email or source tells no account apart. */
  filled = Option.filter((detail: string) => detail !== ""),
  /* The base label at `index`, numbered when other accounts share it. */
  inTier = (bases: readonly string[], index: number): string => {
    const base = bases[index] ?? "",
      before = bases.slice(FIRST, index).filter((other) => other === base),
      total = bases.filter((other) => other === base).length

    if (total <= SINGLE) {
      return base
    }

    return `${base} ${before.length + NEXT}`
  },
  /*
   * One label per account: the subscription tier, numbered when several
   * accounts share it, then the email or else the source.
   */
  labelAll = (accounts: readonly LabelSource[]): string[] => {
    const bases = accounts.map((account) => baseLabel(account.credentials))

    return accounts.map((account, index) => {
      const label = inTier(bases, index)

      return account.email.pipe(
        filled,
        Option.orElse(() => filled(account.source)),
        Option.match({
          onNone: () => label,
          onSome: (detail) => `${label}: ${detail}`,
        }),
      )
    })
  }

/** Labels that tell the Claude Code accounts on this machine apart. */
export default Object.freeze({ buildAccountLabels: labelAll })
