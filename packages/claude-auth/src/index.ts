import type { Plugin, AuthHook } from "@opencode-ai/plugin"
import { readClaudeCredentials, type ClaudeCredentials } from "./keychain.js"

const ANTHROPIC_REFRESH_URL = "https://platform.claude.com/v1/oauth/token"

async function tryRefreshToken(currentRefreshToken: string): Promise<ClaudeCredentials | null> {
  try {
    const response = await fetch(ANTHROPIC_REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: currentRefreshToken }),
    })
    if (!response.ok) return null
    const data = (await response.json()) as Record<string, unknown>
    const access = data.access_token ?? data.accessToken
    const refresh = data.refresh_token ?? data.refreshToken
    const expiresIn = data.expires_in
    if (typeof access !== "string" || typeof refresh !== "string") return null
    const expiresAt =
      typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : Date.now() + 3600 * 1000
    return { accessToken: access, refreshToken: refresh, expiresAt }
  } catch {
    return null
  }
}

function createAuthFetch(
  initial: ClaudeCredentials,
  onRefresh: (updated: ClaudeCredentials) => void,
): (...args: Parameters<typeof fetch>) => Promise<Response> {
  let current = initial

  return async (pluginFetchInput, init): Promise<Response> => {
    // Check expiry with 60-second buffer
    if (current.expiresAt < Date.now() + 60_000) {
      // Re-read keychain first — Claude Code may have refreshed the token
      const fresh = readClaudeCredentials()
      if (fresh && fresh.expiresAt > Date.now() + 60_000) {
        current = fresh
        onRefresh(current)
      } else {
        // Keychain also stale — try OAuth refresh
        const refreshed = await tryRefreshToken(current.refreshToken)
        if (refreshed) {
          current = refreshed
          onRefresh(current)
        } else {
          throw new Error(
            "opencode-claude-auth: Token expired and refresh failed. " +
              "Re-authenticate with Claude Code by running `claude` in your terminal.",
          )
        }
      }
    }

    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${current.accessToken}`)
    return fetch(pluginFetchInput, { ...init, headers })
  }
}

const plugin: Plugin = async (input) => {
  if (process.platform !== "darwin") {
    return {}
  }

  const auth: AuthHook = {
    provider: "anthropic",
    loader: async (_getAuth, _provider) => {
      const creds = readClaudeCredentials()
      if (!creds) {
        throw new Error(
          "opencode-claude-auth: Claude Code credentials not found in macOS Keychain. " +
            "Please authenticate with Claude Code first by running `claude` in your terminal.",
        )
      }

      await input.client.auth.set({
        path: { id: "anthropic" },
        body: {
          type: "oauth",
          access: creds.accessToken,
          refresh: creds.refreshToken,
          expires: creds.expiresAt,
        },
      })

      return {
        apiKey: "oauth",
        fetch: createAuthFetch(creds, (updated) => {
          // Fire-and-forget: persist refreshed token; non-fatal if this fails
          void input.client.auth.set({
            path: { id: "anthropic" },
            body: {
              type: "oauth",
              access: updated.accessToken,
              refresh: updated.refreshToken,
              expires: updated.expiresAt,
            },
          })
        }),
      }
    },
    methods: [] as AuthHook["methods"],
  }

  return { auth }
}

export default plugin
