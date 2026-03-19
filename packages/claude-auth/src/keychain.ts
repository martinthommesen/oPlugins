import { execSync } from "node:child_process"

export interface ClaudeCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

// Service name used by Claude Code to store credentials in macOS Keychain
const SERVICE_NAME = "Claude Code-credentials"

/**
 * Reads Claude Code OAuth credentials from macOS Keychain.
 * Returns null on non-macOS or when credentials are not found.
 * Throws with descriptive errors for other failure cases.
 */
export function readClaudeCredentials(): ClaudeCredentials | null {
  if (process.platform !== "darwin") {
    return null
  }

  let raw: string
  try {
    raw = execSync(`security find-generic-password -s "${SERVICE_NAME}" -w`, {
      timeout: 2000,
      encoding: "utf-8",
    }).trim()
  } catch (err: unknown) {
    const error = err as { status?: number; code?: string; killed?: boolean }

    if (error.killed || error.code === "ETIMEDOUT") {
      throw new Error(
        "Keychain read timed out. This can happen on macOS Tahoe. Try restarting Keychain Access."
      )
    }

    if (error.status === 44) {
      // Entry not found — return null so OpenCode can try other auth methods
      return null
    }

    if (error.status === 36) {
      throw new Error(
        "macOS Keychain is locked. Please unlock it or run: security unlock-keychain ~/Library/Keychains/login.keychain-db"
      )
    }

    if (error.status === 128) {
      throw new Error(
        "Keychain access was denied. Please grant access when prompted by macOS."
      )
    }

    throw new Error(
      `Failed to read Claude Code credentials from Keychain (exit ${error.status ?? "unknown"}). Try re-authenticating with Claude Code.`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      "Claude Code credentials exist but contain invalid JSON. Try re-authenticating with Claude Code."
    )
  }

  // Handle both nested and flat formats:
  // Nested (newer): { "claudeAiOauth": { "accessToken": ..., "refreshToken": ..., "expiresAt": ... } }
  // Flat (older):   { "accessToken": ..., "refreshToken": ..., "expiresAt": ... }
  const data =
    (parsed as { claudeAiOauth?: unknown }).claudeAiOauth ?? parsed

  const creds = data as {
    accessToken?: unknown
    refreshToken?: unknown
    expiresAt?: unknown
  }

  if (typeof creds.accessToken !== "string") {
    throw new Error(
      "Claude Code credentials are incomplete (missing accessToken). Try re-authenticating with Claude Code."
    )
  }
  if (typeof creds.refreshToken !== "string") {
    throw new Error(
      "Claude Code credentials are incomplete (missing refreshToken). Try re-authenticating with Claude Code."
    )
  }
  if (typeof creds.expiresAt !== "number") {
    throw new Error(
      "Claude Code credentials are incomplete (missing expiresAt). Try re-authenticating with Claude Code."
    )
  }

  return {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  }
}
