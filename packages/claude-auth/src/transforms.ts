import type { Credential } from "@opencode/plugin"
import type {
  SessionContext,
  SessionHttpRequest,
  SessionRequest,
} from "@opencode/plugin/promise/session"
import { randomUUID } from "node:crypto"
import { singleLineFromEnv } from "./env.ts"
import { isRecord, parseJsonRecord, type JsonRecord } from "./json.ts"
import { log } from "./logger.ts"
import { BILLING_HEADER_PREFIX, buildBillingHeaderValue } from "./signing.ts"
import { config, getModelBetas } from "./model-config.ts"

export const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

const CONTEXT_METADATA_KEY = "griffinmartin.claude-auth"
const TOOL_PREFIX = "mcp_"
const processSessionID = randomUUID()
const encoder = new TextEncoder()
const decoder = new TextDecoder()

type ContextMessage = SessionContext["messages"][number]
type ContextPart = ContextMessage["content"][number]

/** Maps each alias this plugin applied back to the OpenCode tool name. */
export type OriginalByAlias = Record<string, string>

/**
 * Anthropic's OAuth billing validator rejects unknown tool names when several
 * tools are present. Claude Code sends third-party tools with an `mcp_`
 * prefix, so subscription traffic does the same on the wire: `mcp_` plus the
 * name with its first letter upper-cased, so `read_file` becomes
 * `mcp_Read_file`. OpenCode's tool registry and dispatch never see the alias.
 * The plugin rewrites the request body on the way out and restores the
 * original names in the response stream. The one OpenCode-visible trace is the name mapping the context hook
 * adds to the first user message so the model can relate instructions that
 * use OpenCode names to the tools it is offered.
 */
function aliasToolName(name: string): string {
  if (name.startsWith(TOOL_PREFIX)) return name
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

/**
 * Assign aliases one-to-one. A name whose alias is already taken, either by a
 * tool that carries that name itself or by an earlier name with the same
 * alias, keeps its own name so no two tools share one wire name.
 *
 * This only sees the names present in the request, so a real MCP tool the
 * request never mentions, such as one from Anthropic's server-side MCP
 * connector, is not protected from colliding with a generated alias.
 */
function buildToolAliases(names: Iterable<string>): Map<string, string> {
  const unique = [...new Set(names)]
  const taken = new Set(unique)
  const aliases = new Map<string, string>()
  for (const name of unique) {
    const alias = aliasToolName(name)
    if (alias === name || taken.has(alias)) continue
    aliases.set(name, alias)
    taken.add(alias)
  }
  return aliases
}

function invert(aliases: Map<string, string>): OriginalByAlias {
  const originalByAlias: OriginalByAlias = {}
  for (const [name, alias] of aliases) originalByAlias[alias] = name
  return originalByAlias
}

function firstUserText(message: ContextMessage | undefined): string {
  const part = message?.content.find(
    (candidate) =>
      candidate.type === "text" &&
      candidate.metadata?.[CONTEXT_METADATA_KEY] !== true,
  )
  return part?.type === "text" ? part.text : ""
}

function markRelocatedText(text: string): ContextPart {
  return {
    type: "text",
    text,
    metadata: { [CONTEXT_METADATA_KEY]: true },
  }
}

/**
 * Rewrite the session context and return the aliases the registered tools
 * will carry on the wire, so a response can be restored even when its request
 * state is unavailable.
 */
export function transformContext(
  event: SessionRequest & { tools?: SessionContext["tools"] },
): OriginalByAlias {
  const aliases = buildToolAliases(Object.keys(event.tools ?? {}))
  const firstUser = event.messages.find((message) => message.role === "user")

  const billing = buildBillingHeaderValue(
    firstUserText(firstUser),
    claudeVersion(),
    entrypoint(),
  )

  const moved: string[] = []
  for (const part of event.system) {
    if (part.text.startsWith(BILLING_HEADER_PREFIX)) continue
    if (part.text.startsWith(SYSTEM_IDENTITY)) {
      const rest = part.text.slice(SYSTEM_IDENTITY.length).replace(/^\n+/, "")
      if (rest) moved.push(rest)
      continue
    }
    if (part.text) moved.push(part.text)
  }

  const hasRelocatedPart = firstUser?.content.some(
    (part) =>
      part.type === "text" && part.metadata?.[CONTEXT_METADATA_KEY] === true,
  )
  const guidance =
    aliases.size > 0
      ? `Tool names in these instructions map as follows: ${[...aliases]
          .map(([name, alias]) => `${name} -> ${alias}`)
          .join(", ")}.`
      : ""
  const relocated = [...moved, guidance].filter(Boolean).join("\n\n")

  if (firstUser && relocated && !hasRelocatedPart) {
    // The message type marks `content` read-only, so the message is replaced.
    event.messages[event.messages.indexOf(firstUser)] = {
      ...firstUser,
      content: [markRelocatedText(relocated), ...firstUser.content],
    }
  }

  event.system = [
    { type: "text", text: billing },
    { type: "text", text: SYSTEM_IDENTITY },
    ...(!firstUser
      ? moved.map((text) => ({ type: "text" as const, text }))
      : []),
  ]

  return invert(aliases)
}

function claudeVersion(): string {
  return singleLineFromEnv("ANTHROPIC_CLI_VERSION", config.ccVersion)
}

function entrypoint(): string {
  return singleLineFromEnv("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")
}

function userAgent(): string {
  return singleLineFromEnv(
    "ANTHROPIC_USER_AGENT",
    `claude-cli/${claudeVersion()} (external, ${entrypoint()})`,
  )
}

const OS_NAMES: Record<string, string> = { darwin: "MacOS" }

const STAINLESS_HEADERS: Array<[string, string]> = [
  ["x-stainless-arch", process.arch],
  ["x-stainless-lang", "js"],
  ["x-stainless-os", OS_NAMES[process.platform] ?? process.platform],
  ["x-stainless-package-version", config.sdkVersion],
  ["x-stainless-retry-count", "0"],
  ["x-stainless-runtime", "node"],
  ["x-stainless-runtime-version", process.version],
  ["x-stainless-timeout", "600"],
]

function transformURL(raw: string): string {
  const url = new URL(raw)
  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
    url.searchParams.set("beta", "true")
  }
  return url.toString()
}

export function buildClaudeHeaders(
  original: HeadersInit,
  accessToken: string,
  modelID: string,
): Headers {
  const headers = new Headers(original)
  const betas = getModelBetas(
    modelID,
    process.env,
    headers.get("anthropic-beta") ?? "",
  )

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", betas.join(","))
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("x-app", "cli")
  headers.set("user-agent", userAgent())
  headers.set("x-client-request-id", randomUUID())
  headers.set("x-claude-code-session-id", processSessionID)
  for (const [name, value] of STAINLESS_HEADERS) {
    if (!headers.has(name)) headers.set(name, value)
  }
  headers.delete("x-api-key")
  // The body is re-serialized after aliasing, so a copied length is stale.
  headers.delete("content-length")
  return headers
}

/** Server tools keep the exact name Anthropic defines for their `type`. */
function isClientTool(tool: JsonRecord): boolean {
  return typeof tool.type !== "string" || tool.type === "custom"
}

type ToolNameHolder = JsonRecord & { name: string }

/** Every record in a Messages API body that names a tool the model may call. */
function toolNameHolders(payload: JsonRecord): ToolNameHolder[] {
  const holders: JsonRecord[] = []
  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) {
      if (isRecord(tool) && isClientTool(tool)) holders.push(tool)
    }
  }
  if (isRecord(payload.tool_choice) && payload.tool_choice.type === "tool") {
    holders.push(payload.tool_choice)
  }
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (!isRecord(message) || !Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (isRecord(block) && block.type === "tool_use") holders.push(block)
      }
    }
  }
  return holders.filter(
    (holder): holder is ToolNameHolder => typeof holder.name === "string",
  )
}

type ToolReference = JsonRecord & { tool_name: string }

function isToolReference(block: JsonRecord): block is ToolReference {
  return block.type === "tool_reference" && typeof block.tool_name === "string"
}

/** Tool-search results reference deferred client tools inside content blocks. */
function toolReferences(payload: JsonRecord): ToolReference[] {
  const references: ToolReference[] = []
  const visit = (content: unknown): void => {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!isRecord(block)) continue
      if (isToolReference(block)) references.push(block)
      // Do not traverse tool inputs or arbitrary JSON results.
      visit(block.content)
    }
  }
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (isRecord(message)) visit(message.content)
    }
  }
  return references
}

/**
 * Rewrite the outbound `/v1/messages` body to Claude Code tool names. Returns
 * the aliases applied so the response stream can restore the original names,
 * and the model the body names. A body that is not the expected JSON shape is
 * passed through untouched.
 */
export function aliasRequestBody(body: Uint8Array<ArrayBuffer>): {
  body: Uint8Array<ArrayBuffer>
  originalByAlias: OriginalByAlias
  model?: string
} {
  const payload = parseJsonRecord(decoder.decode(body))
  if (!payload) {
    // Sent un-aliased, which the billing validator may reject over tool names.
    log("request_body_not_json", { bytes: body.byteLength })
    return { body, originalByAlias: {} }
  }
  const model = typeof payload.model === "string" ? payload.model : undefined

  const holders = toolNameHolders(payload)
  const references = toolReferences(payload)
  const aliases = buildToolAliases([
    ...holders.map((holder) => holder.name),
    ...references.map((reference) => reference.tool_name),
  ])
  if (aliases.size === 0) return { body, originalByAlias: {}, model }

  for (const holder of holders) {
    const alias = aliases.get(holder.name)
    if (alias) holder.name = alias
  }
  for (const reference of references) {
    const alias = aliases.get(reference.tool_name)
    if (alias) reference.tool_name = alias
  }
  return {
    body: encoder.encode(JSON.stringify(payload)),
    originalByAlias: invert(aliases),
    model,
  }
}

/** Replace only the aliases this plugin applied, leaving real MCP names alone. */
export function restoreToolNames(
  text: string,
  originalByAlias: OriginalByAlias,
): string {
  return text.replace(
    /"(name|tool_name)"\s*:\s*"(mcp_[^"]*)"/g,
    (match, field: string, alias: string) =>
      alias in originalByAlias
        ? `"${field}":${JSON.stringify(originalByAlias[alias])}`
        : match,
  )
}

const EVENT_BOUNDARIES = ["\r\n\r\n", "\n\n", "\r\r"]

/**
 * Whether a response body is text this plugin may decode. Rewriting runs
 * through TextDecoder, which replaces every invalid byte with U+FFFD, so a
 * binary body a proxy returned must pass through untouched.
 */
function isTextualBody(response: Response): boolean {
  const type = response.headers.get("content-type")
  if (!type) return true
  const lowered = type.toLowerCase()
  return (
    lowered.includes("event-stream") ||
    lowered.includes("json") ||
    lowered.startsWith("text/")
  )
}

/** One less than the longest boundary: the most that can straddle a chunk edge. */
const BOUNDARY_CARRY = Math.max(...EVENT_BOUNDARIES.map((b) => b.length)) - 1

/**
 * Index just past the last SSE event boundary in `buffer`, or -1. The SSE
 * spec ends an event with a blank line and allows CRLF, LF, or CR line ends.
 *
 * `from` is the length the buffer had before the newest chunk. Everything
 * below it was already searched and found boundary-free, so the scan starts
 * just far enough back to catch a boundary split across the chunk edge.
 * Without that, a body with no framing rescans everything received so far on
 * every chunk, which is quadratic in the body size.
 */
function lastEventBoundary(buffer: string, from: number): number {
  const start = Math.max(0, from - BOUNDARY_CARRY)
  const tail = buffer.slice(start)
  let end = -1
  for (const boundary of EVENT_BOUNDARIES) {
    const index = tail.lastIndexOf(boundary)
    if (index !== -1) end = Math.max(end, start + index + boundary.length)
  }
  return end
}

/**
 * Restore original tool names in the response body so OpenCode sees the tools
 * it registered. Chunks are flushed on SSE event boundaries so a tool name is
 * never split across two rewrites. A body without event boundaries, such as a
 * non-streaming JSON response, is rewritten whole when the stream ends. The
 * caller reads such a body whole anyway, so holding it costs one more copy.
 */
export function restoreResponseToolNames(
  response: Response,
  originalByAlias: OriginalByAlias,
): Response {
  if (
    !response.body ||
    Object.keys(originalByAlias).length === 0 ||
    !isTextualBody(response)
  ) {
    return response
  }

  const streamDecoder = new TextDecoder()
  let buffer = ""

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const searched = buffer.length
        buffer += streamDecoder.decode(chunk, { stream: true })
        const boundary = lastEventBoundary(buffer, searched)
        if (boundary === -1) return
        const complete = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary)
        controller.enqueue(
          encoder.encode(restoreToolNames(complete, originalByAlias)),
        )
      },
      flush(controller) {
        buffer += streamDecoder.decode()
        if (!buffer) return
        controller.enqueue(
          encoder.encode(restoreToolNames(buffer, originalByAlias)),
        )
        buffer = ""
      },
    }),
  )

  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export interface RequestSnapshot {
  url: string
  method: string
  headers: Array<[string, string]>
  body: Uint8Array<ArrayBuffer> | null
  cache: RequestCache
  credentials: RequestCredentials
  integrity: string
  keepalive: boolean
  mode: RequestMode
  redirect: RequestRedirect
  referrer: string
  referrerPolicy: ReferrerPolicy
  signal: AbortSignal
  modelID: string
}

async function snapshotRequest(
  event: SessionHttpRequest,
): Promise<{ snapshot: RequestSnapshot; originalByAlias: OriginalByAlias }> {
  const request = event.request
  const aliased = request.body
    ? aliasRequestBody(new Uint8Array(await request.clone().arrayBuffer()))
    : null
  const snapshot: RequestSnapshot = {
    url: transformURL(request.url),
    method: request.method,
    headers: [...request.headers.entries()],
    body: aliased?.body ?? null,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
    // A body that names no model keeps the host's model ID.
    modelID: aliased?.model ?? event.model.id,
  }
  return { snapshot, originalByAlias: aliased?.originalByAlias ?? {} }
}

export function buildRequestFromSnapshot(
  snapshot: RequestSnapshot,
  credential: Credential.OAuth,
): Request {
  const canHaveBody = snapshot.method !== "GET" && snapshot.method !== "HEAD"
  return new Request(snapshot.url, {
    method: snapshot.method,
    headers: buildClaudeHeaders(
      snapshot.headers,
      credential.access,
      snapshot.modelID,
    ),
    // The Request constructor copies the buffer, so a retry can reuse it.
    body: canHaveBody && snapshot.body !== null ? snapshot.body : undefined,
    cache: snapshot.cache,
    credentials: snapshot.credentials,
    integrity: snapshot.integrity,
    keepalive: snapshot.keepalive,
    mode: snapshot.mode,
    redirect: snapshot.redirect,
    referrer: snapshot.referrer,
    referrerPolicy: snapshot.referrerPolicy,
    signal: snapshot.signal,
  })
}

/**
 * The plugin's own 429 while token refresh is unavailable. `retry-after` is
 * whole seconds, rounded up so a client never retries early, and capped at
 * the longest cooldown.
 */
export function retryableRefreshResponse(retryAfterMs: number): Response {
  const retryAfterSeconds = Math.min(
    60,
    Math.max(1, Math.ceil(retryAfterMs / 1000)),
  )
  return Response.json(
    {
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "Claude token refresh is temporarily unavailable.",
      },
    },
    {
      status: 429,
      headers: {
        "retry-after": String(retryAfterSeconds),
        "x-should-retry": "true",
      },
    },
  )
}

/**
 * A 401 in the API's own error shape, so the SDK reports `message` the way it
 * reports any provider error. Used when recovery from a 401 ended in a
 * credential error the user has to act on.
 */
export function authenticationErrorResponse(message: string): Response {
  return Response.json(
    { type: "error", error: { type: "authentication_error", message } },
    { status: 401 },
  )
}

export async function transformRequest(
  event: SessionHttpRequest,
  credential: Credential.OAuth,
): Promise<{
  request: Request
  snapshot: RequestSnapshot
  originalByAlias: OriginalByAlias
}> {
  const { snapshot, originalByAlias } = await snapshotRequest(event)
  return {
    request: buildRequestFromSnapshot(snapshot, credential),
    snapshot,
    originalByAlias,
  }
}
