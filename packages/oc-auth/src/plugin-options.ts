import { Context, Effect, Layer, Schema, SchemaTransformation } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import modelConfig from "./model-config.ts"
import pluginOptions from "@oc-lib/plugin-options/plugin-options.ts"

/** What a value that a request header can't carry is told. */
const ACCEPTED_IN_HEADERS = {
    expected:
      "only printable Latin-1 characters, which a request header can carry",
  },
  /*
   * What a request header value can hold once control characters are gone:
   * printable Latin-1, which is all Fetch's `Headers` takes. A character past
   * U+00FF would make building every request's headers fail.
   */
  ALLOWED_HEADER_CHARACTERS = /^[\u0020-\u007E\u00A0-\u00FF]*$/u,
  /*
   * A comma-separated list of beta flags that names at least one. Each flag,
   * trimmed as the `anthropic-beta` header gets it, must be header text.
   */
  BetaFlags = Schema.String.check(
    Schema.isPattern(/[^\s,]/u, {
      expected: "a comma-separated list naming at least one beta flag",
    }),
    Schema.makeFilter(
      (raw: string) =>
        modelConfig
          .parseBetas(raw)
          .every((flag) => ALLOWED_HEADER_CHARACTERS.test(flag)),
      ACCEPTED_IN_HEADERS,
    ),
  ),
  // A C0 or C1 control character would break out of a header slot.
  CONTROL_CHARACTERS = /\p{Cc}/gu,
  /** How costs are reported: native API prices, or zero while subscribed. */
  Cost = Schema.Literals(["api", "zero"]),
  DEFAULT_LOCK_TTL_MS = 20_000,
  DEFAULT_REFRESH_COOLDOWN_MS = 15_000,
  /** Every control character as a space, then trimmed. */
  HeaderCleanup = SchemaTransformation.transform({
    decode: (raw: string) => raw.replaceAll(CONTROL_CHARACTERS, " ").trim(),
    encode: (text: string) => text,
  }),
  /**
   * Header text, which must keep something printable once cleaned up, and
   * nothing a header can't carry.
   */
  HeaderContent = Schema.String.check(
    Schema.isNonEmpty({ expected: "text with a printable character" }),
    Schema.isPattern(ALLOWED_HEADER_CHARACTERS, ACCEPTED_IN_HEADERS),
  ),
  /*
   * Text that lands in request headers and system prompt blocks, so a value
   * cannot add lines to either.
   */
  HeaderText = Schema.String.pipe(
    Schema.decodeTo(HeaderContent, HeaderCleanup),
  ),
  MINIMUM_EXCLUSIVE = 0,
  /** A whole number of milliseconds above zero. */
  Milliseconds = Schema.Int.check(Schema.isGreaterThan(MINIMUM_EXCLUSIVE)),
  /** Every option the plugin accepts, each absent one at its default. */
  OptionFields = {
    betaFlags: Schema.OptionFromOptionalKey(BetaFlags),
    cliVersion: Schema.OptionFromOptionalKey(HeaderText),
    cost: Cost.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed<typeof Cost.Type>("api")),
    ),
    entrypoint: Schema.OptionFromOptionalKey(HeaderText),
    refreshCooldownMs: Milliseconds.pipe(
      Schema.withDecodingDefaultKey(
        Effect.succeed(DEFAULT_REFRESH_COOLDOWN_MS),
      ),
    ),
    refreshLockTtlMs: Milliseconds.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_LOCK_TTL_MS)),
    ),
    userAgent: Schema.OptionFromOptionalKey(HeaderText),
  },
  /** The plugin's options, decoded. */
  Options = Schema.Struct(OptionFields),
  /*
   * The options in the host's raw options, decoded. Any problem fails,
   * naming every offending option, so a default never replaces a mistyped
   * name or value.
   */
  optionsFrom = pluginOptions.decode(Options, "oc-auth")

/**
 * The plugin's options from `opencode.jsonc`, decoded once when it starts.
 * An absent option has its default; an absent text option is none.
 */
class PluginOptions extends Context.Service<
  PluginOptions,
  typeof Options.Type
>()("@martinthommesen/oc-auth/plugin-options/PluginOptions") {
  /* The options in the host's `raw` options, or a failure naming each problem. */
  public static readonly layer = (
    raw: Plugin.Context["options"],
  ): Layer.Layer<PluginOptions, PluginOptionsError> =>
    Layer.effect(
      PluginOptions,
      Effect.gen(function* decode() {
        return PluginOptions.of(yield* optionsFrom(raw))
      }),
    )
}

export default PluginOptions
