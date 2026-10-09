import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
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
  PRIMARY_SERVICE,
  readCredentialsFile,
  readAllClaudeAccounts,
  refreshAccount,
  tokenFingerprint,
  updateCredentialBlob,
  writeBackCredentials,
} from "./keychain.ts"
import { withEnv, withPlatform } from "./test-helpers.ts"

const tempDirs: string[] = []
const restores: Array<() => void> = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-claude-auth-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const restore of restores.splice(0).toReversed()) restore()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function credentialBlob(accessToken: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      expiresAt: 2000,
      subscriptionType: "pro",
    },
  })
}

/**
 * A `security` stand-in backed by files in `state`: one file per service
 * holding its blob, `<service>.account` for the item's account name,
 * `<service>.exit` to force an exit status, and `dump` for `dump-keychain`.
 * Writes land in `<service>` and record the account used in
 * `<service>.written-as`. The platform is forced to darwin so the Keychain
 * paths run on every CI host.
 */
function installFakeKeychain(): { state: string; home: string } {
  const home = tempDir()
  const state = tempDir()
  const bin = tempDir()
  const security = join(bin, "security")
  writeFileSync(
    security,
    `#!/bin/sh
state=${JSON.stringify(state)}
command="$1"
shift
service=""
account=""
password=0
previous=""
for value in "$@"; do
  [ "$previous" = "-s" ] && service="$value"
  [ "$previous" = "-a" ] && account="$value"
  [ "$value" = "-w" ] && password=1
  previous="$value"
done
case "$command" in
  dump-keychain)
    cat "$state/dump"
    ;;
  find-generic-password)
    [ -f "$state/$service.exit" ] && exit "$(cat "$state/$service.exit")"
    [ -f "$state/$service" ] || exit 44
    if [ "$password" = 1 ]; then
      cat "$state/$service"
      # A queued "<service>.flip" lands after this read, so the next one sees
      # a different blob. Models an external rotation mid-write-back.
      if [ -f "$state/$service.flip" ]; then
        mv "$state/$service.flip" "$state/$service"
      fi
    elif [ -f "$state/$service.account" ]; then
      printf '"acct"<blob>="%s"\\n' "$(cat "$state/$service.account")"
    fi
    ;;
  add-generic-password)
    cat > "$state/$service"
    printf '%s' "$account" > "$state/$service.written-as"
    ;;
  *)
    exit 1
    ;;
esac
`,
  )
  chmodSync(security, 0o755)

  restores.push(
    withEnv("HOME", home),
    withEnv("OPENCODE_CLAUDE_AUTH_SECURITY_BIN", security),
    withEnv("CLAUDE_CONFIG_DIR", undefined),
    withPlatform("darwin"),
    clearSuffixToDirCache,
  )
  clearSuffixToDirCache()
  return { state, home }
}

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

  it("reads the configured credentials file", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, ".credentials.json"), credentialBlob("file-access"))
    assert.equal((await readCredentialsFile(dir))?.accessToken, "file-access")
  })

  it("discovers the configured file source on non-macOS platforms", async () => {
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
    restores.push(withPlatform("linux"), withEnv("CLAUDE_CONFIG_DIR", dir))
    assert.deepEqual(await readAllClaudeAccounts(), [
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
  })

  describe("macOS Keychain", () => {
    it("discovers and labels multiple accounts", async () => {
      const { state, home } = installFakeKeychain()
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
      const suffixed = `${PRIMARY_SERVICE}-${keychainSuffixForDir(workDir)}`
      writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("one-access"))
      writeFileSync(join(state, suffixed), credentialBlob("two-access"))
      writeFileSync(
        join(state, "dump"),
        `"${suffixed}"\n"${PRIMARY_SERVICE}"\n`,
      )

      const accounts = await readAllClaudeAccounts()
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
            source: PRIMARY_SERVICE,
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
    })

    it("skips an inaccessible entry and reports it only when nothing loads", async () => {
      const { state } = installFakeKeychain()
      const suffixed = `${PRIMARY_SERVICE}-0123abcd`
      writeFileSync(join(state, `${PRIMARY_SERVICE}.exit`), "36")
      writeFileSync(join(state, suffixed), credentialBlob("two-access"))
      writeFileSync(
        join(state, "dump"),
        `"${PRIMARY_SERVICE}"\n"${suffixed}"\n`,
      )

      const accounts = await readAllClaudeAccounts()
      assert.deepEqual(
        accounts.map((account) => account.source),
        [suffixed],
      )

      writeFileSync(join(state, `${suffixed}.exit`), "36")
      await assert.rejects(readAllClaudeAccounts(), /Keychain is locked/)
    })

    it("writes refreshed tokens back to the item's existing account", async () => {
      const { state } = installFakeKeychain()
      writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("old"))
      writeFileSync(join(state, `${PRIMARY_SERVICE}.account`), "me@example.com")

      assert.equal(
        await writeBackCredentials(
          PRIMARY_SERVICE,
          {
            accessToken: "new",
            refreshToken: "new-refresh",
            expiresAt: 3000,
          },
          undefined,
          "old",
        ),
        "written",
      )
      const stored = JSON.parse(
        readFileSync(join(state, PRIMARY_SERVICE), "utf8"),
      )
      assert.equal(stored.claudeAiOauth.accessToken, "new")
      assert.equal(stored.claudeAiOauth.subscriptionType, "pro")
      assert.equal(
        readFileSync(join(state, `${PRIMARY_SERVICE}.written-as`), "utf8"),
        "me@example.com",
      )
    })

    it("refuses to write when the item's account name is unknown", async () => {
      const { state } = installFakeKeychain()
      writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("old"))

      assert.equal(
        await writeBackCredentials(
          PRIMARY_SERVICE,
          { accessToken: "new", refreshToken: "r", expiresAt: 3000 },
          undefined,
          "old",
        ),
        // The lookup can fail for transient reasons too, so this reports the
        // store as unreachable rather than as a decision against the write.
        "unavailable",
      )
      assert.equal(
        JSON.parse(readFileSync(join(state, PRIMARY_SERVICE), "utf8"))
          .claudeAiOauth.accessToken,
        "old",
      )
      assert.equal(
        existsSync(join(state, `${PRIMARY_SERVICE}.written-as`)),
        false,
      )
    })

    it("reports a stale-token conflict and a missing item as failure", async () => {
      const { state } = installFakeKeychain()
      writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("winner"))
      writeFileSync(join(state, `${PRIMARY_SERVICE}.account`), "me@example.com")
      const refreshed = { accessToken: "new", refreshToken: "r", expiresAt: 3 }

      assert.equal(
        await writeBackCredentials(
          PRIMARY_SERVICE,
          refreshed,
          undefined,
          "old",
        ),
        "conflict",
      )
      assert.equal(
        JSON.parse(readFileSync(join(state, PRIMARY_SERVICE), "utf8"))
          .claudeAiOauth.accessToken,
        "winner",
      )
      assert.equal(
        await writeBackCredentials(
          `${PRIMARY_SERVICE}-deadbeef`,
          refreshed,
          undefined,
          "old",
        ),
        "failed",
      )
    })

    it("declines when the item rotates between the guard read and the write", async () => {
      const { state } = installFakeKeychain()
      writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("old"))
      writeFileSync(join(state, `${PRIMARY_SERVICE}.account`), "me@example.com")
      writeFileSync(
        join(state, `${PRIMARY_SERVICE}.flip`),
        credentialBlob("external"),
      )

      assert.equal(
        await writeBackCredentials(
          PRIMARY_SERVICE,
          { accessToken: "new", refreshToken: "r", expiresAt: 3000 },
          undefined,
          "old",
        ),
        "conflict",
      )
      assert.equal(
        JSON.parse(readFileSync(join(state, PRIMARY_SERVICE), "utf8"))
          .claudeAiOauth.accessToken,
        "external",
      )
      assert.equal(
        existsSync(join(state, `${PRIMARY_SERVICE}.written-as`)),
        false,
      )
    })

    it("fails rather than writing over a blob that stopped parsing", async () => {
      const { state } = installFakeKeychain()
      writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("old"))
      writeFileSync(join(state, `${PRIMARY_SERVICE}.account`), "me@example.com")
      writeFileSync(join(state, `${PRIMARY_SERVICE}.flip`), "{ truncated")

      assert.equal(
        await writeBackCredentials(
          PRIMARY_SERVICE,
          { accessToken: "new", refreshToken: "r", expiresAt: 3000 },
          undefined,
          "old",
        ),
        "failed",
      )
      assert.equal(
        readFileSync(join(state, PRIMARY_SERVICE), "utf8"),
        "{ truncated",
      )
    })

    it("refuses a source name that is not a Claude Code item", async () => {
      const { state } = installFakeKeychain()
      writeFileSync(join(state, "Some Other App"), credentialBlob("theirs"))
      writeFileSync(join(state, "Some Other App.account"), "them@example.com")

      assert.equal(
        await writeBackCredentials(
          "Some Other App",
          { accessToken: "new", refreshToken: "r", expiresAt: 3000 },
          undefined,
          "theirs",
        ),
        "failed",
      )
      assert.equal(
        JSON.parse(readFileSync(join(state, "Some Other App"), "utf8"))
          .claudeAiOauth.accessToken,
        "theirs",
      )
    })

    it("reads an account's current credentials through the Keychain", async () => {
      const { state } = installFakeKeychain()
      writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("current"))

      const credentials = await refreshAccount(PRIMARY_SERVICE)
      assert.equal(credentials?.accessToken, "current")
      assert.equal(credentials?.refreshToken, "current-refresh")
      assert.equal(await refreshAccount(`${PRIMARY_SERVICE}-deadbeef`), null)
    })
  })

  it("has no Keychain to write to off macOS", async () => {
    restores.push(withPlatform("linux"))
    assert.equal(
      await writeBackCredentials(
        PRIMARY_SERVICE,
        { accessToken: "new", refreshToken: "r", expiresAt: 3000 },
        undefined,
        "old",
      ),
      "failed",
    )
  })

  it("reads an account's current credentials from the configured file", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, ".credentials.json"), credentialBlob("from-file"))
    const credentials = await refreshAccount("file", dir)
    assert.equal(credentials?.accessToken, "from-file")
    assert.equal(await refreshAccount("file", tempDir()), null)
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
    assert.equal(tokenFingerprint("token").length, 32)
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

  it("updates the matching source and preserves unrelated data", async () => {
    const { dir, path } = credentialFile()
    assert.equal(
      await writeBackCredentials("file", refreshed, dir, "old"),
      "written",
    )
    const data = JSON.parse(readFileSync(path, "utf8"))
    assert.equal(data.claudeAiOauth.accessToken, "new")
    assert.equal(data.claudeAiOauth.subscriptionType, "max")
    assert.equal(data.mcpOAuth.server.name, "keep")
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600)
    }
  })

  it("reports a stale-token conflict without overwriting", async () => {
    const { dir, path } = credentialFile("winner")
    assert.equal(
      await writeBackCredentials("file", refreshed, dir, "old"),
      "conflict",
    )
    assert.equal(
      JSON.parse(readFileSync(path, "utf8")).claudeAiOauth.accessToken,
      "winner",
    )
  })

  it("reports malformed or missing storage as a failure", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, ".credentials.json"), "not json")
    assert.equal(
      await writeBackCredentials("file", refreshed, dir, "old"),
      "failed",
    )
    assert.equal(
      await writeBackCredentials(
        "file",
        refreshed,
        join(dir, "missing"),
        "old",
      ),
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
