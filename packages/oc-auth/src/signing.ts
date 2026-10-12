import { Crypto, Effect } from "effect"
import { Hex } from "effect/encoding"

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:",
  BILLING_SALT = "59cf53e54c78",
  FIRST_SAMPLE = 4,
  LAST_SAMPLE = 20,
  MIDDLE_SAMPLE = 7,
  PADDING = "0",
  SAMPLE_INDICES = [FIRST_SAMPLE, MIDDLE_SAMPLE, LAST_SAMPLE],
  SUFFIX_END = 3,
  SUFFIX_START = 0,
  byteEncoder = new TextEncoder(),
  /*
   * The characters at indices 4, 7, and 20 of `messageText`, each "0" when
   * the message is too short to have it.
   */
  charSample = (messageText: string): string =>
    SAMPLE_INDICES.map((index) => messageText.at(index) ?? PADDING).join(""),
  /*
   * The 3-character version suffix: the sampled characters hashed with the
   * billing salt and version string. SHA-256 cannot fail on a working
   * platform, so a failure is a defect rather than a request error.
   */
  computeSuffix = Effect.fn("Signing.versionSuffix")(function* computeSuffix(
    messageText: string,
    version: string,
  ) {
    const crypto = yield* Crypto.Crypto,
      digest = yield* crypto
        .digest(
          "SHA-256",
          byteEncoder.encode(
            `${BILLING_SALT}${charSample(messageText)}${version}`,
          ),
        )
        .pipe(Effect.orDie)

    return Hex.encode(digest).slice(SUFFIX_START, SUFFIX_END)
  }),
  /*
   * The billing header to insert into `system[0]`, in the form
   * `x-anthropic-billing-header: cc_version=V.S; cc_entrypoint=E; cch=00000;`.
   * `text` is the first text block of the first user message, the one Claude
   * Code itself picks.
   */
  headerValue = Effect.fn("Signing.billingHeader")(function* headerValue(
    text: string,
    version: string,
    entrypoint: string,
  ) {
    const suffix = yield* computeSuffix(text, version)

    return [
      `${BILLING_HEADER_PREFIX} `,
      `cc_version=${version}.${suffix}; `,
      `cc_entrypoint=${entrypoint}; `,
      // The current CLI uses a fixed placeholder, not a user-message hash.
      "cch=00000;",
    ].join("")
  })

/** The billing header Anthropic's subscription validator expects in `system`. */
export default Object.freeze({
  billingHeader: headerValue,
  prefix: BILLING_HEADER_PREFIX,
  versionSuffix: computeSuffix,
})
