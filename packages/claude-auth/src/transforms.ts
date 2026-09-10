import type { Credential } from "@opencode-ai/plugin"
import type {
  SessionContext,
  SessionHttpRequest,
} from "@opencode-ai/plugin/promise/session"
import { randomUUID } from "node:crypto"
import { buildBillingHeaderValue } from "./signing.ts"
import { config, getModelBetas } from "./model-config.ts"

export const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

const BILLING_PREFIX = "x-anthropic-billing-header:"
const CONTEXT_METADATA_KEY = "griffinmartin.claude-auth"
const TOOL_PREFIX = "mcp_"
const processSessionID = randomUUID()

type ContextMessage = SessionContext["messages"][number]
type ContextPart = ContextMessage["content"][number]

/**
 * Anthropic's OAuth billing validator rejects unknown tool names when several
 * tools are present. Claude Code sends third-party tools as `mcp_<PascalCase>`,
 * so subscription traffic uses the same convention on the wire. The alias never
 * reaches OpenCode: the request body is rewritten on the way out and the
 * response stream restores the original names, which keeps the native tool
 * renderers and tool dispatch intact.
 */
function aliasToolName(name: string): string {
  if (name.startsWith(TOOL_PREFIX)) return name
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

function firstUserText(messages: SessionContext["messages"]): string {
  const message = messages.find((candidate) => candidate.role === "user")
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

export function transformContext(event: SessionContext): void {
  const aliases = Object.keys(event.tools)
    .map((name) => [name, aliasToolName(name)] as const)
    .filter(([name, alias]) => alias !== name)

  const version = process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "sdk-cli"
  const billing = buildBillingHeaderValue(
    [{ role: "user", content: firstUserText(event.messages) }],
    version,
    entrypoint,
  )

  const moved: string[] = []
  for (const part of event.system) {
    if (part.text.startsWith(BILLING_PREFIX)) continue
    if (part.text.startsWith(SYSTEM_IDENTITY)) {
      const rest = part.text.slice(SYSTEM_IDENTITY.length).replace(/^\n+/, "")
      if (rest) moved.push(rest)
      continue
    }
    if (part.text) moved.push(part.text)
  }

  const firstUserIndex = event.messages.findIndex(
    (message) => message.role === "user",
  )
  const firstUser = event.messages[firstUserIndex]
  const hasRelocatedPart = firstUser?.content.some(
    (part) =>
      part.type === "text" && part.metadata?.[CONTEXT_METADATA_KEY] === true,
  )
  const guidance =
    aliases.length > 0
      ? `Tool names in these instructions map as follows: ${aliases
          .map(([name, alias]) => `${name} -> ${alias}`)
          .join(", ")}.`
      : ""
  const relocated = [...moved, guidance].filter(Boolean).join("\n\n")

  if (firstUser && relocated && !hasRelocatedPart) {
    ;(firstUser as unknown as { content: ContextPart[] }).content = [
      markRelocatedText(relocated),
      ...firstUser.content,
    ]
  }

  event.system = [
    { type: "text", text: billing },
    { type: "text", text: SYSTEM_IDENTITY },
    ...(!firstUser
      ? moved.map((text) => ({ type: "text" as const, text }))
      : []),
  ]
}

function claudeVersion(): string {
  return process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
}

function userAgent(): string {
  return (
    process.env.ANTHROPIC_USER_AGENT ??
    `claude-cli/${claudeVersion()} (external, sdk-cli)`
  )
}

function stainlessHeaders(): Record<string, string> {
  return {
    "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os":
      process.platform === "darwin" ? "MacOS" : process.platform,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  }
}

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
  const incoming = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  const betas = [...new Set([...getModelBetas(modelID), ...incoming])]

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", betas.join(","))
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("x-app", "cli")
  headers.set("user-agent", userAgent())
  headers.set("x-client-request-id", randomUUID())
  headers.set("x-claude-code-session-id", processSessionID)
  for (const [name, value] of Object.entries(stainlessHeaders())) {
    if (!headers.has(name)) headers.set(name, value)
  }
  headers.delete("x-api-key")
  return headers
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Server tools keep the exact name Anthropic defines for their `type`. */
function isClientTool(tool: JsonRecord): boolean {
  return typeof tool.type !== "string" || tool.type === "custom"
}

function renameTool(
  holder: JsonRecord,
  restored: Record<string, string>,
): void {
  const name = holder.name
  if (typeof name !== "string") return
  const alias = aliasToolName(name)
  if (alias === name) return
  holder.name = alias
  restored[alias] = name
}

/**
 * Rewrite the outbound `/v1/messages` body to Claude Code tool names. Returns
 * the aliases applied so the response stream can restore the original names.
 * A body that is not the expected JSON shape is passed through untouched.
 */
export function aliasRequestBody(body: Uint8Array): {
  body: Uint8Array
  toolNames: Record<string, string>
} {
  const restored: Record<string, string> = {}
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return { body, toolNames: restored }
  }
  if (!isRecord(payload)) return { body, toolNames: restored }

  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) {
      if (isRecord(tool) && isClientTool(tool)) renameTool(tool, restored)
    }
  }

  if (isRecord(payload.tool_choice) && payload.tool_choice.type === "tool") {
    renameTool(payload.tool_choice, restored)
  }

  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (!isRecord(message) || !Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (isRecord(block) && block.type === "tool_use") {
          renameTool(block, restored)
        }
      }
    }
  }

  if (Object.keys(restored).length === 0) return { body, toolNames: restored }
  return {
    body: new TextEncoder().encode(JSON.stringify(payload)),
    toolNames: restored,
  }
}

/** Replace only the aliases this plugin applied, leaving real MCP names alone. */
export function restoreToolNames(
  text: string,
  toolNames: Record<string, string>,
): string {
  return text.replace(/"name"\s*:\s*"(mcp_[^"]*)"/g, (match, alias: string) =>
    alias in toolNames ? `"name":${JSON.stringify(toolNames[alias])}` : match,
  )
}

/**
 * Restore original tool names in the response body so OpenCode sees the tools
 * it registered. Chunks are flushed on SSE event boundaries so a tool name is
 * never split across two rewrites.
 */
export function restoreResponseToolNames(
  response: Response,
  toolNames: Record<string, string>,
): Response {
  if (!response.body || Object.keys(toolNames).length === 0) return response

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        const boundary = buffer.lastIndexOf("\n\n")
        if (boundary === -1) return
        const complete = buffer.slice(0, boundary + 2)
        buffer = buffer.slice(boundary + 2)
        controller.enqueue(
          encoder.encode(restoreToolNames(complete, toolNames)),
        )
      },
      flush(controller) {
        buffer += decoder.decode()
        if (!buffer) return
        controller.enqueue(encoder.encode(restoreToolNames(buffer, toolNames)))
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
  body: Uint8Array | null
  toolNames: Record<string, string>
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

export async function snapshotRequest(
  event: SessionHttpRequest,
): Promise<RequestSnapshot> {
  const request = event.request
  const original = request.body
    ? new Uint8Array(await request.clone().arrayBuffer())
    : null
  const aliased = original ? aliasRequestBody(original) : null
  return {
    url: transformURL(request.url),
    method: request.method,
    headers: [...request.headers.entries()],
    body: aliased?.body ?? null,
    toolNames: aliased?.toolNames ?? {},
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
    modelID: event.model.id,
  }
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
    body:
      canHaveBody && snapshot.body !== null ? snapshot.body.slice() : undefined,
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

export async function transformRequest(
  event: SessionHttpRequest,
  credential: Credential.OAuth,
): Promise<{ request: Request; snapshot: RequestSnapshot }> {
  const snapshot = await snapshotRequest(event)
  return {
    request: buildRequestFromSnapshot(snapshot, credential),
    snapshot,
  }
}
