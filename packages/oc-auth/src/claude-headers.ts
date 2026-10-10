import { Match, Option } from "effect"
import type Environment from "./environment.ts"
import type PluginOptions from "./plugin-options.ts"
import modelConfig from "./model-config.ts"

type Options = PluginOptions["Service"]

type ProcessFacts = Environment["Service"]["process"]

/** What one outbound request's Claude Code headers are built from. */
interface HeaderRequest {
  /** The OAuth access token the request is sent with. */
  readonly accessToken: string
  /** The model the request is for, which selects its betas. */
  readonly modelID: string
  /** The headers the request already carries. */
  readonly original: Headers
  /** A fresh id for this request. */
  readonly requestID: string
  /** The id this plugin's process reports for every request. */
  readonly sessionID: string
}

const ANTHROPIC_VERSION = "2023-06-01",
  DEFAULT_ENTRYPOINT = "sdk-cli",
  /* The Claude Code version this plugin presents as. */
  cliVersion = (options: Options): string =>
    Option.getOrElse(options.cliVersion, () => modelConfig.ccVersion),
  /* The Claude Code entrypoint this plugin presents as. */
  entrypoint = (options: Options): string =>
    Option.getOrElse(options.entrypoint, () => DEFAULT_ENTRYPOINT),
  /* The SDK's platform headers, which a request keeps when it already has them. */
  stainlessHeaders = (
    facts: ProcessFacts,
  ): readonly (readonly [string, string])[] => [
    ["x-stainless-arch", facts.arch],
    ["x-stainless-lang", "js"],
    [
      "x-stainless-os",
      Match.value(facts.platform).pipe(
        Match.when("darwin", () => "MacOS"),
        Match.orElse((platform) => platform),
      ),
    ],
    ["x-stainless-package-version", modelConfig.sdkVersion],
    ["x-stainless-retry-count", "0"],
    ["x-stainless-runtime", "node"],
    ["x-stainless-runtime-version", facts.nodeVersion],
    ["x-stainless-timeout", "600"],
  ],
  /* The user agent: the `userAgent` option verbatim, or the CLI's own. */
  userAgent = (options: Options): string =>
    Option.getOrElse(
      options.userAgent,
      () =>
        `claude-cli/${cliVersion(options)} (external, ${entrypoint(options)})`,
    ),
  /* The headers every request carries, replacing any it already has. */
  viaOAuth = (
    request: HeaderRequest,
    options: Options,
    incomingBetas: string,
  ): readonly (readonly [string, string])[] => [
    ["authorization", `Bearer ${request.accessToken}`],
    ["anthropic-version", ANTHROPIC_VERSION],
    [
      "anthropic-beta",
      modelConfig
        .modelBetas(request.modelID, options.betaFlags, incomingBetas)
        .join(","),
    ],
    ["anthropic-dangerous-direct-browser-access", "true"],
    ["x-app", "cli"],
    ["user-agent", userAgent(options)],
    ["x-client-request-id", request.requestID],
    ["x-claude-code-session-id", request.sessionID],
  ],
  /*
   * The request's headers as Claude Code sends them: its OAuth identity and
   * betas set, the SDK's platform headers defaulted, and the API key removed.
   */
  wireHeaders = (
    request: HeaderRequest,
    options: Options,
    facts: ProcessFacts,
  ): Headers => {
    const headers = new Headers(request.original)

    for (const [name, value] of viaOAuth(
      request,
      options,
      headers.get("anthropic-beta") ?? "",
    )) {
      headers.set(name, value)
    }

    for (const [name, value] of stainlessHeaders(facts)) {
      if (!headers.has(name)) {
        headers.set(name, value)
      }
    }

    headers.delete("x-api-key")
    // The body is re-serialized after aliasing, so a copied length is stale.
    headers.delete("content-length")

    return headers
  }

/** The headers and identity that make a request look like Claude Code's. */
export default Object.freeze({ build: wireHeaders, cliVersion, entrypoint })
