import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

/** A positive integer from the environment, or `fallback` when unset or invalid. */
export function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * A single-line string from the environment, or `fallback` when unset or
 * empty. A value of only whitespace or control characters yields "".
 *
 * Values read through here land in request headers and in system prompt
 * blocks, where a control character would break out of its slot rather than
 * be rejected. Sanitizing here covers every call site, so none has to
 * remember to do it.
 */
export function singleLineFromEnv(name: string, fallback: string): string {
  const raw = process.env[name]
  return raw ? raw.replace(/\p{Cc}/gu, " ").trim() : fallback
}

export function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME
  return xdg && isAbsolute(xdg)
    ? join(xdg, "opencode")
    : join(homedir(), ".local", "share", "opencode")
}
