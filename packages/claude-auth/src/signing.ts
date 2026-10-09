import { createHash } from "node:crypto"

const BILLING_SALT = "59cf53e54c78"

/**
 * Compute the 3-char version suffix.
 * Samples characters at indices 4, 7, 20 from the message text (padding
 * with "0" when the message is shorter), then hashes with the billing salt
 * and version string.
 */
export function computeVersionSuffix(
  messageText: string,
  version: string,
): string {
  const sampled = [4, 7, 20]
    .map((i) => (i < messageText.length ? messageText[i] : "0"))
    .join("")
  const input = `${BILLING_SALT}${sampled}${version}`
  return createHash("sha256").update(input).digest("hex").slice(0, 3)
}

/**
 * Build the complete billing header string for insertion into system[0].
 * `text` is the first user message's first text block, as Claude Code's own
 * extraction selects it.
 * Format: x-anthropic-billing-header: cc_version=V.S; cc_entrypoint=E; cch=H;
 */
export function buildBillingHeaderValue(
  text: string,
  version: string,
  entrypoint: string,
): string {
  const suffix = computeVersionSuffix(text, version)
  return (
    `x-anthropic-billing-header: ` +
    `cc_version=${version}.${suffix}; ` +
    `cc_entrypoint=${entrypoint}; ` +
    // The current CLI uses a fixed placeholder, not a user-message hash.
    `cch=00000;`
  )
}
