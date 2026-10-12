import { Array as Arr, Option } from "effect"

/*
 * Betas subscription auth cannot work without. The `betaFlags` option replaces
 * the rest of the base set, but dropping these turns every request into an
 * unexplained billing rejection, so they are re-added after any override.
 */
const AUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"],
  /** The Claude Code release whose request shape the plugin copies. */
  CC_VERSION = "2.1.295",
  CONTEXT_SUFFIX = /\[1m\]$/u,
  EFFORT_BETA = "effort-2025-11-24",
  LEGACY_PREFIX = "claude-3-",
  /*
   * Claude Code decides per model whether to send the effort beta. The
   * predicate in the 2.1.295 binary denies these legacy ids. Unknown
   * first-party models still enable effort by default:
   *
   *   n.includes("claude-3-") || n === "claude-opus-4-0" ||
   *   n === "claude-opus-4-1" || n === "claude-sonnet-4-0" ||
   *   n === "claude-sonnet-4-5" || n === "claude-haiku-4-5"
   *
   * Mirroring the denylist keeps new models correct by default; an allowlist
   * silently drops the flag for every model released after its last refresh.
   * Dated snapshots and the context suffix are stripped before exact
   * matching; substring matches would deny future versions such as
   * claude-sonnet-4-50. That stripping is why the set also holds the bare
   * `claude-opus-4` and `claude-sonnet-4`: they are what
   * `claude-opus-4-20250514` and `claude-sonnet-4-20250514` (the 4.0
   * releases) reduce to. The CLI's `includes("claude-3-")` becomes
   * `startsWith` on the canonical id, which is the same test for first-party
   * ids.
   */
  NO_EFFORT_MODELS = new Set([
    "claude-opus-4",
    "claude-opus-4-0",
    "claude-opus-4-1",
    "claude-sonnet-4",
    "claude-sonnet-4-0",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ]),
  /** The `@anthropic-ai/sdk` version bundled with the Claude Code release above. */
  SDK_VERSION = "0.128.0",
  SNAPSHOT_SUFFIX = /-\d{8}$/u,
  /** Frozen because every request shares it, so no importer may change it. */
  STANDARD_BETAS: readonly string[] = Object.freeze([
    ...AUTH_BETAS,
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
    "thinking-token-count-2026-05-13",
    EFFORT_BETA,
    "extended-cache-ttl-2025-04-11",
  ]),
  /* The comma-separated flags in `raw`, trimmed, without empty entries. */
  parseBetas = (raw: string): readonly string[] =>
    raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== ""),
  /* Whether Claude Code sends the effort beta for `modelId`. */
  supportsEffort = (modelId: string): boolean => {
    const canonical = modelId
      .toLowerCase()
      .replace(CONTEXT_SUFFIX, "")
      .replace(SNAPSHOT_SUFFIX, "")

    return (
      !canonical.startsWith(LEGACY_PREFIX) && !NO_EFFORT_MODELS.has(canonical)
    )
  },
  /*
   * Beta flags for a model: the base set (or `override`, the `betaFlags`
   * option) merged with the flags the caller already sent (`incoming`, the
   * raw `anthropic-beta` header) and the betas subscription auth requires,
   * minus the effort beta for models that do not support it. The exclusion
   * runs after the merge, so an inbound header cannot add the flag back.
   */
  wireBetas = (
    modelId: string,
    override: Option.Option<string>,
    incoming: string,
  ): readonly string[] => {
    const explicit = parseBetas(Option.getOrElse(override, () => "")),
      /*
       * An override of only separators parses to nothing; that is a malformed
       * value, not a request to send an empty beta set.
       */
      selected = Option.getOrElse(
        Option.liftPredicate(explicit, (betas) =>
          Arr.isReadonlyArrayNonEmpty(betas),
        ),
        () => STANDARD_BETAS,
      ),
      wire = new Set([...AUTH_BETAS, ...selected, ...parseBetas(incoming)])

    return [...wire].filter(
      (beta) => beta !== EFFORT_BETA || supportsEffort(modelId),
    )
  }

/** The Claude Code release this plugin presents as, and its beta flags. */
export default Object.freeze({
  baseBetas: STANDARD_BETAS,
  ccVersion: CC_VERSION,
  modelBetas: wireBetas,
  sdkVersion: SDK_VERSION,
})
