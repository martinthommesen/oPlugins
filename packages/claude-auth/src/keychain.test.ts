import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"
import {
  buildAccountLabels,
  credentialSourceID,
  keychainSuffixForDir,
  parseCredentials,
  PRIMARY_SERVICE,
  readCredentialsFile,
  readAllClaudeAccounts,
  readSourceCredentials,
  tokenFingerprint,
  updateCredentialBlob,
  writeBackCredentials,
} from "./keychain.ts"
import {
  captureWarnings,
  removeTempDirs,
  tempDir,
  withEnv,
  withPlatform,
} from "./test-helpers.ts"

const restores: Array<() => void> = []

afterEach(() => {
  for (const restore of restores.splice(0).toReversed()) restore()
  removeTempDirs()
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
 * `<service>.written-as`; `<service>.drop` makes every write exit 0 without
 * storing anything, and `<service>.drop-once` loses one write and leaves its
 * own content (when it has any) in the item, as another writer would. A
 * `<service>.flip` replaces the item right after the account lookup, which
 * models a rotation landing while a write is being prepared. Every
 * invocation's argv is appended to `argv.log`. The platform is forced to
 * darwin so the Keychain paths run on every CI host.
 *
 * It mirrors the real tool where the real tool is surprising, because the
 * plugin's write path depends on those details (each was checked against
 * `/usr/bin/security` on macOS):
 * - `-w` as the last argument prompts twice through getpass, which reads
 *   stdin when there is no terminal, keeps at most 128 characters, reads EOF
 *   as an empty string, and accepts two matching empty entries.
 * - `-i` executes commands read from stdin in 4096-byte line chunks; a longer
 *   line is split, and its first fragment still runs.
 * - Account names print verbatim between quotes, or as `0x<hex>` followed by
 *   an octal-escaped form when they hold a backslash or non-ASCII bytes.
 * - `find-generic-password -w` prints a password holding any byte outside
 *   printable ASCII as bare lowercase hex.
 */
function installFakeKeychain(): { state: string; home: string } {
  const home = tempDir()
  const state = tempDir()
  const bin = tempDir()
  const security = join(bin, "security")
  writeFileSync(
    security,
    `#!${process.execPath}
const fs = require("node:fs")
const path = require("node:path")
const state = ${JSON.stringify(state)}
const file = (name) => path.join(state, name)

fs.appendFileSync(file("argv.log"), JSON.stringify(process.argv.slice(2)) + "\\n")

let stdinLines = null
function nextStdinLine() {
  stdinLines ??= fs.readFileSync(0, "utf8").split("\\n")
  return stdinLines.shift() ?? ""
}

function getpass() {
  return nextStdinLine().slice(0, 128)
}

function printAccount(account) {
  const bytes = Buffer.from(account, "utf8")
  const plain = [...bytes].every((b) => b >= 0x20 && b < 0x7f && b !== 0x5c)
  if (plain) return '"acct"<blob>="' + account + '"'
  const octal = [...bytes]
    .map((b) => b >= 0x20 && b < 0x7f && b !== 0x5c
      ? String.fromCharCode(b)
      : "\\\\" + b.toString(8).padStart(3, "0"))
    .join("")
  return '"acct"<blob>=0x' + bytes.toString("hex").toUpperCase() + '  "' + octal + '"'
}

function run(argv) {
  const [command, ...args] = argv
  const option = (flag) => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  const service = option("-s") ?? ""
  switch (command) {
    case "dump-keychain":
      process.stdout.write(fs.readFileSync(file("dump"), "utf8"))
      return 0
    case "find-generic-password": {
      if (fs.existsSync(file(service + ".exit"))) {
        return Number(fs.readFileSync(file(service + ".exit"), "utf8"))
      }
      if (!fs.existsSync(file(service))) return 44
      if (args.includes("-w")) {
        const stored = fs.readFileSync(file(service))
        const printable = [...stored].every((b) => b >= 0x20 && b < 0x7f)
        process.stdout.write(
          (printable ? stored.toString("utf8") : stored.toString("hex")) + "\\n",
        )
        return 0
      }
      if (fs.existsSync(file(service + ".account"))) {
        const account = fs.readFileSync(file(service + ".account"), "utf8")
        process.stdout.write("    " + printAccount(account) + "\\n")
      }
      if (fs.existsSync(file(service + ".flip"))) {
        fs.renameSync(file(service + ".flip"), file(service))
      }
      return 0
    }
    case "add-generic-password": {
      let password
      if (args.includes("-X")) {
        password = Buffer.from(option("-X"), "hex").toString("utf8")
      } else if (args.at(-1) === "-w") {
        for (let attempt = 0; attempt < 3 && password === undefined; attempt++) {
          const first = getpass()
          if (getpass() === first) password = first
        }
        if (password === undefined) return 1
      } else {
        password = option("-w")
      }
      if (fs.existsSync(file(service + ".drop-once"))) {
        const other = fs.readFileSync(file(service + ".drop-once"))
        fs.unlinkSync(file(service + ".drop-once"))
        if (other.length > 0) fs.writeFileSync(file(service), other)
      } else if (!fs.existsSync(file(service + ".drop"))) {
        fs.writeFileSync(file(service), password)
      }
      fs.writeFileSync(file(service + ".written-as"), option("-a") ?? "")
      return 0
    }
    default:
      return 1
  }
}

/** Split one \`security -i\` line the way the real tool does. */
function tokenize(line) {
  const tokens = []
  let current = null
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "\\\\" && i + 1 < line.length) {
      current = (current ?? "") + line[++i]
    } else if (c === '"') {
      quoted = !quoted
      current ??= ""
    } else if (!quoted && /\\s/.test(c)) {
      if (current !== null) tokens.push(current)
      current = null
    } else {
      current = (current ?? "") + c
    }
  }
  if (current !== null) tokens.push(current)
  return tokens
}

const argv = process.argv.slice(2)
if (argv[0] === "-i") {
  let status = 0
  const input = fs.readFileSync(0, "utf8")
  for (const line of input.split("\\n")) {
    for (let start = 0; start < Math.max(line.length, 1); start += 4095) {
      const tokens = tokenize(line.slice(start, start + 4095))
      if (tokens.length === 0) continue
      const code = run(tokens)
      if (code !== 0) status = code
    }
  }
  process.exit(status)
}
process.exit(run(argv))
`,
  )
  chmodSync(security, 0o755)

  restores.push(
    withEnv("HOME", home),
    withEnv("OPENCODE_CLAUDE_AUTH_SECURITY_BIN", security),
    withEnv("CLAUDE_CONFIG_DIR", undefined),
    withPlatform("darwin"),
  )
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

    it("falls back to the primary item and says so when listing fails", async () => {
      const { lines: warnings, restore } = captureWarnings()
      restores.push(restore)
      const { state } = installFakeKeychain()
      // No "dump" file, so dump-keychain exits non-zero.
      writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("one-access"))

      const accounts = await readAllClaudeAccounts()
      assert.deepEqual(
        accounts.map((account) => account.source),
        [PRIMARY_SERVICE],
      )
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /only the primary Claude Code account/)
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

    it("keeps the refreshed tokens off the command line", async () => {
      const { state } = installFakeKeychain()
      writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("old"))
      writeFileSync(join(state, `${PRIMARY_SERVICE}.account`), "me@example.com")

      assert.equal(
        await writeBackCredentials(
          PRIMARY_SERVICE,
          {
            accessToken: "new-access-secret",
            refreshToken: "new-refresh-secret",
            expiresAt: 3000,
          },
          undefined,
          "old",
        ),
        "written",
      )
      const argv = readFileSync(join(state, "argv.log"), "utf8")
      for (const secret of ["new-access-secret", "new-refresh-secret"]) {
        assert.equal(argv.includes(secret), false)
        assert.equal(
          argv.toLowerCase().includes(Buffer.from(secret).toString("hex")),
          false,
        )
      }
    })

    it("writes a blob too long for one interactive line in full", async () => {
      const { state } = installFakeKeychain()
      const large = JSON.parse(credentialBlob("old"))
      large.mcpOAuth = { server: { accessToken: "m".repeat(6000) } }
      writeFileSync(join(state, PRIMARY_SERVICE), JSON.stringify(large))
      writeFileSync(join(state, `${PRIMARY_SERVICE}.account`), "me@example.com")

      assert.equal(
        await writeBackCredentials(
          PRIMARY_SERVICE,
          { accessToken: "new", refreshToken: "new-refresh", expiresAt: 3000 },
          undefined,
          "old",
        ),
        "written",
      )
      const stored = JSON.parse(
        readFileSync(join(state, PRIMARY_SERVICE), "utf8"),
      )
      assert.equal(stored.claudeAiOauth.accessToken, "new")
      assert.equal(stored.mcpOAuth.server.accessToken, "m".repeat(6000))
    })

    it("reads an item whose blob holds non-ASCII text", async () => {
      const { state } = installFakeKeychain()
      const blob = JSON.parse(credentialBlob("current"))
      blob.claudeAiOauth.note = "ünïcode"
      writeFileSync(join(state, PRIMARY_SERVICE), JSON.stringify(blob))

      const credentials = await readSourceCredentials(PRIMARY_SERVICE)
      assert.equal(credentials?.accessToken, "current")
    })

    it("keeps a written blob readable when it holds non-ASCII text", async () => {
      const { state } = installFakeKeychain()
      const blob = JSON.parse(credentialBlob("old"))
      blob.claudeAiOauth.note = "ünïcode"
      writeFileSync(join(state, PRIMARY_SERVICE), JSON.stringify(blob))
      writeFileSync(join(state, `${PRIMARY_SERVICE}.account`), "me@example.com")

      assert.equal(
        await writeBackCredentials(
          PRIMARY_SERVICE,
          { accessToken: "new", refreshToken: "r", expiresAt: 3000 },
          undefined,
          "old",
        ),
        "written",
      )
      const stored = readFileSync(join(state, PRIMARY_SERVICE), "utf8")
      assert.match(stored, /^[\x20-\x7e]*$/)
      assert.equal(JSON.parse(stored).claudeAiOauth.note, "ünïcode")
    })

    it("tries once more when a write does not land", async () => {
      const { state } = installFakeKeychain()
      writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("old"))
      writeFileSync(join(state, `${PRIMARY_SERVICE}.account`), "me@example.com")
      writeFileSync(join(state, `${PRIMARY_SERVICE}.drop-once`), "")

      assert.equal(
        await writeBackCredentials(
          PRIMARY_SERVICE,
          { accessToken: "new", refreshToken: "new-refresh", expiresAt: 3000 },
          undefined,
          "old",
        ),
        "written",
      )
      const writes = readFileSync(join(state, "argv.log"), "utf8")
        .split("\n")
        .filter((line) => line === '["-i"]')
      assert.equal(writes.length, 2)
    })

    it("keeps the original guard token when it tries again", async () => {
      // The write is lost and the user runs `claude` before the next attempt.
      // Re-reading the guard token then would compare the item against itself
      // and overwrite that login.
      const { state } = installFakeKeychain()
      writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("old"))
      writeFileSync(join(state, `${PRIMARY_SERVICE}.account`), "me@example.com")
      writeFileSync(
        join(state, `${PRIMARY_SERVICE}.drop-once`),
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
    })

    it("reports a write that did not land as unavailable", async () => {
      const { state } = installFakeKeychain()
      writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("old"))
      writeFileSync(join(state, `${PRIMARY_SERVICE}.account`), "me@example.com")
      writeFileSync(join(state, `${PRIMARY_SERVICE}.drop`), "")

      assert.equal(
        await writeBackCredentials(
          PRIMARY_SERVICE,
          { accessToken: "new", refreshToken: "new-refresh", expiresAt: 3000 },
          undefined,
          "old",
        ),
        "unavailable",
      )
    })

    for (const account of ['has"quote', "back\\slash", "ünïcode", "sp ace"]) {
      it(`writes under the exact account name ${JSON.stringify(account)}`, async () => {
        const { state } = installFakeKeychain()
        writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("old"))
        writeFileSync(join(state, `${PRIMARY_SERVICE}.account`), account)

        assert.equal(
          await writeBackCredentials(
            PRIMARY_SERVICE,
            { accessToken: "new", refreshToken: "r", expiresAt: 3000 },
            undefined,
            "old",
          ),
          "written",
        )
        assert.equal(
          readFileSync(join(state, `${PRIMARY_SERVICE}.written-as`), "utf8"),
          account,
        )
      })
    }

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
        // An item without an account cannot be updated in place, and asking
        // again will not give it one.
        "failed",
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

    it("declines when the item rotates while the write is prepared", async () => {
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

    it("will not read a source that is not a Claude Code item", async () => {
      const { state } = installFakeKeychain()
      writeFileSync(join(state, "Some Other App"), credentialBlob("theirs"))

      assert.equal(await readSourceCredentials("Some Other App"), null)
      assert.equal(existsSync(join(state, "argv.log")), false)
    })

    it("reads an account's current credentials through the Keychain", async () => {
      const { state } = installFakeKeychain()
      writeFileSync(join(state, PRIMARY_SERVICE), credentialBlob("current"))

      const credentials = await readSourceCredentials(PRIMARY_SERVICE)
      assert.equal(credentials?.accessToken, "current")
      assert.equal(credentials?.refreshToken, "current-refresh")
      assert.equal(
        await readSourceCredentials(`${PRIMARY_SERVICE}-deadbeef`),
        null,
      )
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
    const credentials = await readSourceCredentials("file", dir)
    assert.equal(credentials?.accessToken, "from-file")
    assert.equal(await readSourceCredentials("file", tempDir()), null)
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

  it("reports an unreadable credentials file instead of 'no credentials'", async () => {
    const dir = tempDir()
    mkdirSync(join(dir, ".credentials.json"))
    await assert.rejects(readCredentialsFile(dir), /EISDIR/)
    assert.equal(await readCredentialsFile(join(dir, "missing")), null)
  })

  it("refuses to update a blob that is not a credential object", () => {
    for (const raw of ["null", "[]", "3", '{"claudeAiOauth":"text"}']) {
      assert.equal(updateCredentialBlob(raw, refreshed), null, raw)
    }
  })

  it("leaves no temp file behind when the rename fails", async () => {
    const { dir, path } = credentialFile()
    // A directory where the temp file would be renamed to: rename fails
    // after the temp file was written.
    rmSync(path)
    mkdirSync(path)
    writeFileSync(join(path, "keep"), "")
    restores.push(() => rmSync(path, { recursive: true, force: true }))
    assert.equal(
      await writeBackCredentials("file", refreshed, dir, "old"),
      "unavailable",
    )
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      [],
    )
  })

  it("sweeps temp files a killed process left behind, and only those", async () => {
    const { dir } = credentialFile()
    const stale = join(dir, ".credentials.json.1.stale.tmp")
    const fresh = join(dir, ".credentials.json.2.fresh.tmp")
    const unrelated = join(dir, "notes.tmp")
    for (const path of [stale, fresh, unrelated]) writeFileSync(path, "")
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(stale, twoHoursAgo, twoHoursAgo)
    utimesSync(unrelated, twoHoursAgo, twoHoursAgo)

    assert.equal(
      await writeBackCredentials("file", refreshed, dir, "old"),
      "written",
    )
    assert.equal(existsSync(stale), false)
    assert.equal(existsSync(fresh), true)
    assert.equal(existsSync(unrelated), true)
  })

  it("replaces the access token inside the wrapper", () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "old",
        refreshToken: "refresh",
        expiresAt: 1,
      },
    })
    assert.equal(
      JSON.parse(updateCredentialBlob(raw, refreshed)!).claudeAiOauth
        .accessToken,
      "new",
    )
  })
})
