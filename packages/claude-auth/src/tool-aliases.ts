import { Option } from "effect"

/** Maps each alias this plugin applied back to the OpenCode tool name. */
type OriginalByAlias = Readonly<Record<string, string>>

const FIRST_LETTER = 1,
  START = 0,
  TOOL_NAME_FIELD = /"(?<field>name|tool_name)"\s*:\s*"(?<alias>mcp_[^"]*)"/gu,
  TOOL_PREFIX = "mcp_",
  /*
   * Anthropic's OAuth billing validator rejects unknown tool names when
   * several tools are present. Claude Code sends third-party tools with an
   * `mcp_` prefix, so subscription traffic does the same on the wire: `mcp_`
   * plus the name with its first letter upper-cased, so `read_file` becomes
   * `mcp_Read_file`. OpenCode's tool registry and dispatch never see the
   * alias. The plugin rewrites the request body on the way out and restores
   * the original names in the response stream. The one OpenCode-visible
   * trace is the name mapping the context hook adds to the first user
   * message so the model can relate instructions that use OpenCode names to
   * the tools it is offered.
   */
  aliasToolName = (name: string): string => {
    if (name.startsWith(TOOL_PREFIX)) {
      return name
    }

    return `${TOOL_PREFIX}${name.charAt(START).toUpperCase()}${name.slice(FIRST_LETTER)}`
  },
  /*
   * Assign aliases one-to-one, in first-seen order. A name whose alias is
   * already taken, either by a tool that carries that name itself or by an
   * earlier name with the same alias, keeps its own name so no two tools
   * share one wire name.
   *
   * This only sees the names present in the request, so a real MCP tool the
   * request never mentions, such as one from Anthropic's server-side MCP
   * connector, is not protected from colliding with a generated alias.
   */
  buildToolAliases = (
    names: readonly string[],
  ): readonly (readonly [string, string])[] => {
    const aliases: (readonly [string, string])[] = [],
      taken = new Set(names)

    for (const name of new Set(names)) {
      const alias = aliasToolName(name)

      if (alias !== name && !taken.has(alias)) {
        aliases.push([name, alias])
        taken.add(alias)
      }
    }

    return aliases
  },
  /* The original name for each alias in `aliases`. */
  invertAliases = (
    aliases: readonly (readonly [string, string])[],
  ): OriginalByAlias =>
    Object.fromEntries(aliases.map(([name, alias]) => [alias, name])),
  /* Both mappings in one; where both map an alias, `later` wins. */
  mergeAliases = (
    earlier: OriginalByAlias,
    later: OriginalByAlias,
  ): OriginalByAlias =>
    Object.fromEntries([...Object.entries(earlier), ...Object.entries(later)]),
  /* Replace only the aliases this plugin applied, leaving real MCP names alone. */
  restoreToolNames = (text: string, originalByAlias: OriginalByAlias): string =>
    text.replaceAll(
      TOOL_NAME_FIELD,
      (match: string, field: string, alias: string): string =>
        Option.match(Option.fromNullishOr(originalByAlias[alias]), {
          onNone: () => match,
          onSome: (original) => `"${field}":${JSON.stringify(original)}`,
        }),
    )

/** Wire aliases for tool names, and their restoration. */
export default Object.freeze({
  build: buildToolAliases,
  invert: invertAliases,
  merge: mergeAliases,
  restore: restoreToolNames,
})
