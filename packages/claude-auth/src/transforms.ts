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
const processSessionID = randomUUID()

type ContextMessage = SessionContext["messages"][number]
type ContextPart = ContextMessage["content"][number]

function aliasToolName(name: string): string {
  if (name.startsWith("mcp_")) return name
  return `mcp_${name.charAt(0).toUpperCase()}${name.slice(1)}`
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
  const aliases = new Map<string, string>()
  for (const [name, definition] of Object.entries(event.tools)) {
    const alias = aliasToolName(name)
    if (alias === name) continue
    if (event.tools[alias] && event.tools[alias] !== definition) continue
    event.tools[alias] = definition
    delete event.tools[name]
    aliases.set(name, alias)
  }

  for (const message of event.messages) {
    for (const part of message.content) {
      if (
        (part.type === "tool-call" || part.type === "tool-result") &&
        aliases.has(part.name)
      ) {
        ;(part as { name: string }).name = aliases.get(part.name)!
      }
    }
  }

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
    aliases.size > 0
      ? `Tool names in these instructions map as follows: ${[...aliases]
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

export interface RequestSnapshot {
  url: string
  method: string
  headers: Array<[string, string]>
  body: Uint8Array | null
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
  return {
    url: transformURL(request.url),
    method: request.method,
    headers: [...request.headers.entries()],
    body: request.body
      ? new Uint8Array(await request.clone().arrayBuffer())
      : null,
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
