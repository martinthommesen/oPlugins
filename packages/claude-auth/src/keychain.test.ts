import assert from "node:assert/strict"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"
import {
  buildAccountLabels,
  clearSuffixToDirCache,
  credentialSourceID,
  credentialBlobMatches,
  keychainSuffixForDir,
  parseCredentials,
  readCredentialsFile,
  readAllClaudeAccounts,
  tokenFingerprint,
  updateCredentialBlob,
  writeBackCredentials,
} from "./keychain.ts"

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-claude-auth-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("Claude credential sources", () => {
  it("parses wrapped and root credentials", () => {
    assert.deepEqual(
      parseCredentials(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 1234.9,
            subscriptionType: "pro",
          },
        }),
      ),
      {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 1234,
        subscriptionType: "pro",
      },
    )
    assert.equal(
      parseCredentials(
        JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 1 }),
      )?.accessToken,
      "a",
    )
    assert.equal(parseCredentials("not json"), null)
    assert.equal(parseCredentials("null"), null)
    assert.equal(
      parseCredentials(
        JSON.stringify({ accessToken: "", refreshToken: "r", expiresAt: 1 }),
      ),
      null,
    )
    assert.equal(
      parseCredentials(
        JSON.stringify({
          accessToken: "a",
          refreshToken: "r",
          expiresAt: Number.POSITIVE_INFINITY,
        }),
      ),
      null,
    )
    assert.equal(
      parseCredentials(JSON.stringify({ mcpOAuth: { server: {} } })),
      null,
    )
  })

  it("reads the configured credentials file", () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "file-access",
          refreshToken: "file-refresh",
          expiresAt: 2000,
        },
      }),
    )
    assert.equal(readCredentialsFile(dir)?.accessToken, "file-access")
  })

  it("discovers the configured file source on non-macOS platforms", () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "file-access",
          refreshToken: "file-refresh",
          expiresAt: 2000,
        },
      }),
    )
    const platform = process.platform
    const configDir = process.env.CLAUDE_CONFIG_DIR
    Object.defineProperty(process, "platform", { value: "linux" })
    process.env.CLAUDE_CONFIG_DIR = dir
    try {
      assert.deepEqual(readAllClaudeAccounts(), [
        {
          label: "Claude",
          source: "file",
          configDir: dir,
          credentials: {
            accessToken: "file-access",
            refreshToken: "file-refresh",
            expiresAt: 2000,
            subscriptionType: undefined,
          },
        },
      ])
    } finally {
      Object.defineProperty(process, "platform", { value: platform })
      if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = configDir
    }
  })

  it("discovers and labels multiple macOS Keychain accounts", () => {
    if (process.platform !== "darwin") return
    const home = tempDir()
    const state = tempDir()
    const bin = tempDir()
    const primaryDir = join(home, ".claude")
    const workDir = join(home, ".work")
    mkdirSync(primaryDir)
    mkdirSync(workDir)
    writeFileSync(
      join(primaryDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "one@example.com" } }),
    )
    writeFileSync(
      join(workDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "two@example.com" } }),
    )
    const suffixed = `Claude Code-credentials-${keychainSuffixForDir(workDir)}`
    const primary = "Claude Code-credentials"
    for (const [source, accessToken] of [
      [primary, "one-access"],
      [suffixed, "two-access"],
    ]) {
      writeFileSync(
        join(state, source),
        JSON.stringify({
          claudeAiOauth: {
            accessToken,
            refreshToken: `${accessToken}-refresh`,
            expiresAt: 2000,
            subscriptionType: "pro",
          },
        }),
      )
    }
    writeFileSync(join(state, "dump"), `"${suffixed}"\n"${primary}"\n`)
    const security = join(bin, "security")
    writeFileSync(
      security,
      `#!/bin/sh
state=${JSON.stringify(state)}
if [ "$1" = "dump-keychain" ]; then cat "$state/dump"; exit 0; fi
if [ "$1" = "find-generic-password" ]; then
  previous=""
  service=""
  for value in "$@"; do
    [ "$previous" = "-s" ] && service="$value"
    previous="$value"
  done
  cat "$state/$service"
  exit 0
fi
exit 1
`,
    )
    chmodSync(security, 0o755)

    const oldHome = process.env.HOME
    const oldPath = process.env.PATH
    const oldSecurityBin = process.env.OPENCODE_CLAUDE_AUTH_SECURITY_BIN
    process.env.HOME = home
    process.env.PATH = `${bin}:${oldPath ?? ""}`
    process.env.OPENCODE_CLAUDE_AUTH_SECURITY_BIN = security
    clearSuffixToDirCache()
    try {
      const accounts = readAllClaudeAccounts()
      assert.deepEqual(
        accounts.map(({ label, source, configDir, credentials }) => ({
          label,
          source,
          configDir,
          accessToken: credentials.accessToken,
        })),
        [
          {
            label: "Claude Pro 1: one@example.com",
            source: primary,
            configDir: primaryDir,
            accessToken: "one-access",
          },
          {
            label: "Claude Pro 2: two@example.com",
            source: suffixed,
            configDir: workDir,
            accessToken: "two-access",
          },
        ],
      )
    } finally {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
      if (oldPath === undefined) delete process.env.PATH
      else process.env.PATH = oldPath
      if (oldSecurityBin === undefined) {
        delete process.env.OPENCODE_CLAUDE_AUTH_SECURITY_BIN
      } else {
        process.env.OPENCODE_CLAUDE_AUTH_SECURITY_BIN = oldSecurityBin
      }
      clearSuffixToDirCache()
    }
  })

  it("labels duplicate subscription tiers with account details", () => {
    const credentials = [
      {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 1,
        subscriptionType: "pro",
      },
      {
        accessToken: "b",
        refreshToken: "r",
        expiresAt: 1,
        subscriptionType: "pro",
      },
    ]
    assert.deepEqual(
      buildAccountLabels(credentials, ["a@example.com", null], ["one", "two"]),
      ["Claude Pro 1: a@example.com", "Claude Pro 2: two"],
    )
  })

  it("creates stable non-secret source fingerprints and config suffixes", () => {
    assert.equal(tokenFingerprint("token"), tokenFingerprint("token"))
    assert.notEqual(tokenFingerprint("token"), tokenFingerprint("other"))
    assert.equal(tokenFingerprint("token").includes("token"), false)
    assert.match(tokenFingerprint("token"), /^[a-f0-9]{32}$/)
    assert.match(keychainSuffixForDir("/tmp/claude"), /^[a-f0-9]{8}$/)
    assert.notEqual(
      credentialSourceID("file", "/tmp/one"),
      credentialSourceID("file", "/tmp/two"),
    )
  })
})

describe("guarded file write-back", () => {
  function credentialFile(accessToken = "old"): {
    dir: string
    path: string
  } {
    const dir = tempDir()
    const path = join(dir, ".credentials.json")
    writeFileSync(
      path,
      JSON.stringify({
        claudeAiOauth: {
          accessToken,
          refreshToken: "old-refresh",
          expiresAt: 1000,
          subscriptionType: "max",
        },
        mcpOAuth: { server: { name: "keep" } },
      }),
      { mode: 0o644 },
    )
    chmodSync(path, 0o644)
    return { dir, path }
  }

  const refreshed = {
    accessToken: "new",
    refreshToken: "new-refresh",
    expiresAt: 2000,
  }

  it("updates the matching source and preserves unrelated data", () => {
    const { dir, path } = credentialFile()
    assert.equal(writeBackCredentials("file", refreshed, dir, "old"), "written")
    const data = JSON.parse(readFileSync(path, "utf8"))
    assert.equal(data.claudeAiOauth.accessToken, "new")
    assert.equal(data.claudeAiOauth.subscriptionType, "max")
    assert.equal(data.mcpOAuth.server.name, "keep")
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600)
    }
  })

  it("reports a compare-and-swap conflict without overwriting", () => {
    const { dir, path } = credentialFile("winner")
    assert.equal(
      writeBackCredentials("file", refreshed, dir, "old"),
      "conflict",
    )
    assert.equal(
      JSON.parse(readFileSync(path, "utf8")).claudeAiOauth.accessToken,
      "winner",
    )
  })

  it("reports malformed or missing storage as a failure", () => {
    const dir = tempDir()
    writeFileSync(join(dir, ".credentials.json"), "not json")
    assert.equal(writeBackCredentials("file", refreshed, dir, "old"), "failed")
    assert.equal(
      writeBackCredentials("file", refreshed, join(dir, "missing"), "old"),
      "failed",
    )
  })

  it("updates blobs only after the expected-token guard", () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "old",
        refreshToken: "refresh",
        expiresAt: 1,
      },
    })
    assert.equal(credentialBlobMatches(raw, "old"), true)
    assert.equal(credentialBlobMatches(raw, "other"), false)
    assert.equal(
      JSON.parse(updateCredentialBlob(raw, refreshed)!).claudeAiOauth
        .accessToken,
      "new",
    )
  })
})
