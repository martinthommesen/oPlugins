import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import type { Writable } from "node:stream"
import { opencodeDataDir } from "./env.ts"

const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]{10,}/
/** Anthropic OAuth and API tokens: `sk-ant-oat01-…`, `sk-ant-api03-…`. */
const ANTHROPIC_TOKEN_PATTERN = /^sk-ant-[A-Za-z0-9]+-/
const REDACTED_KEYS = new Set([
  "access",
  "accessToken",
  "account",
  "refresh",
  "refreshToken",
  "x-api-key",
])
const DISABLED_VALUES = new Set(["0", "false", "no", "off"])
const ENABLED_VALUES = new Set(["1", "true", "yes", "on"])
const MAX_DEPTH = 4

let sink: ((line: string) => void) | null = null

/**
 * The log file for `CLAUDE_AUTH_DEBUG`, or null when logging is off. A
 * non-boolean value is a literal path; {@link truncate} decides whether that
 * path may be overwritten.
 */
export function resolveLogPath(raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  const lowered = value.toLowerCase()
  if (DISABLED_VALUES.has(lowered)) return null
  if (ENABLED_VALUES.has(lowered)) {
    return join(opencodeDataDir(), "claude-auth-debug.log")
  }
  if (!isAbsolute(value)) {
    throw new Error(
      `CLAUDE_AUTH_DEBUG must be 1 or an absolute log file path (got "${value}")`,
    )
  }
  return value
}

/** Whether a file's existing content was written by this logger. */
function isOwnLog(path: string): boolean {
  // A bounded prefix: the first record is enough to identify the file, and
  // an existing log can be arbitrarily large.
  const prefix = Buffer.alloc(4096)
  let read: number
  let handle: number
  try {
    handle = openSync(path, "r")
  } catch {
    return false
  }
  try {
    read = readSync(handle, prefix, 0, prefix.length, 0)
  } catch {
    return false
  } finally {
    closeSync(handle)
  }
  const text = prefix.subarray(0, read).toString("utf-8")
  if (text.trim().length === 0) return true
  try {
    const first = JSON.parse(text.split("\n")[0]) as Record<string, unknown>
    return typeof first.ts === "string" && typeof first.event === "string"
  } catch {
    return false
  }
}

/**
 * Start a fresh log at `path`.
 *
 * Every service start truncates the log, so `CLAUDE_AUTH_DEBUG` is a delete
 * primitive pointed at an arbitrary path. Rather than blocklist filenames one
 * at a time, this refuses to overwrite any existing file that is not already
 * one of these logs — which covers `.credentials.json`, `auth.json`, `.env`,
 * and everything else nobody has thought of yet.
 */
function truncate(path: string): void {
  if (existsSync(path) && !isOwnLog(path)) {
    throw new Error(
      `CLAUDE_AUTH_DEBUG refuses to truncate "${path}": it is not a claude-auth log`,
    )
  }
  writeFileSync(path, "", { encoding: "utf-8", mode: 0o600 })
}

export function initLogger(options?: { stream?: Writable }): void {
  closeLogger()

  if (options?.stream) {
    const stream = options.stream
    sink = (line) => stream.write(line)
    return
  }

  const path = resolveLogPath(process.env.CLAUDE_AUTH_DEBUG)
  if (!path) return

  // The log names accounts and config paths, so it is kept as private as the
  // credentials it describes.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  truncate(path)
  if (process.platform !== "win32") chmodSync(path, 0o600)
  sink = (line) => appendFileSync(path, line, "utf-8")
}

export function log(event: string, data?: Record<string, unknown>): void {
  if (!sink) return
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...redact(data ?? {}),
  }
  try {
    sink(JSON.stringify(entry) + "\n")
  } catch {
    // A full disk must not turn a successful credential read into a failure.
  }
}

export function closeLogger(): void {
  sink = null
}

/** The message of a thrown value, for log fields. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redactValue(key: string, value: unknown, depth: number): unknown {
  if (REDACTED_KEYS.has(key)) return "REDACTED"
  if (typeof value === "string") {
    return JWT_PATTERN.test(value) || ANTHROPIC_TOKEN_PATTERN.test(value)
      ? `${value.slice(0, 8)}...REDACTED`
      : value
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue("", item, depth + 1))
  }
  return redact(value as Record<string, unknown>, depth + 1)
}

export function redact(
  data: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    result[key] = redactValue(key, value, depth)
  }
  return result
}
