/**
 * Write-back against the real `/usr/bin/security`, which the stub in
 * `keychain.test.ts` can only imitate. A stub once hid a write that stored an
 * empty password and exited 0, so CI runs this on macOS.
 *
 * Opt-in with CLAUDE_AUTH_LIVE_KEYCHAIN=1: it adds throwaway items to the
 * default keychain (named like Claude Code's, with a random suffix no config
 * directory maps to) and deletes them again.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { readSourceCredentials, writeBackCredentials } from "./keychain.ts"

const enabled =
  process.platform === "darwin" && process.env.CLAUDE_AUTH_LIVE_KEYCHAIN === "1"

function security(...args: string[]): string {
  return execFileSync("/usr/bin/security", args, {
    encoding: "utf8",
    maxBuffer: 1 << 24,
  })
}

/** Create a throwaway item holding `blob`, run `body`, then delete it. */
async function withItem(
  blob: object,
  body: (service: string) => Promise<void>,
): Promise<void> {
  const service = `Claude Code-credentials-${randomBytes(8).toString("hex")}`
  security(
    "add-generic-password",
    "-s",
    service,
    "-a",
    'live "test" \\ account',
    "-X",
    Buffer.from(JSON.stringify(blob)).toString("hex"),
  )
  try {
    await body(service)
  } finally {
    security("delete-generic-password", "-s", service)
    assert.throws(
      () => security("find-generic-password", "-s", service),
      "write-back must update the item, not add a second one",
    )
  }
}

describe(
  "write-back through the real security tool",
  { skip: !enabled },
  () => {
    const refreshed = {
      accessToken: "live-new-access",
      refreshToken: "live-new-refresh",
      expiresAt: 4_000_000_000_000,
    }

    for (const [name, padding] of [
      ["fits one interactive line", 0],
      ["is too long for one interactive line", 6000],
    ] as const) {
      it(`stores the full blob when it ${name}`, async () => {
        const blob: Record<string, unknown> = {
          claudeAiOauth: {
            accessToken: "live-old-access",
            refreshToken: "live-old-refresh",
            expiresAt: 1000,
            note: "ünïcode",
          },
        }
        if (padding) blob.mcpOAuth = { server: { token: "m".repeat(padding) } }

        await withItem(blob, async (service) => {
          assert.equal(
            await writeBackCredentials(
              service,
              refreshed,
              undefined,
              "live-old-access",
            ),
            "written",
          )
          const stored = await readSourceCredentials(service)
          assert.equal(stored?.accessToken, "live-new-access")
          assert.equal(stored?.refreshToken, "live-new-refresh")
          const raw = JSON.parse(
            security("find-generic-password", "-s", service, "-w").trim(),
          )
          assert.equal(raw.claudeAiOauth.note, "ünïcode")
          if (padding) assert.equal(raw.mcpOAuth.server.token.length, padding)
        })
      })
    }
  },
)
