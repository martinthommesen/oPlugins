/**
 * Manual packed-package smoke test for OpenCode v2.
 *
 * By default this copies one valid Claude Code account into an isolated source
 * and verifies package loading, automatic import, account labeling, zero-cost
 * catalog output, and one real read-tool round trip. It never refreshes the
 * copied token because doing so would invalidate its original source.
 *
 * To exercise near-expiry refresh and write-back, set
 * CLAUDE_AUTH_HEADLESS_REFRESH_CONFIG_DIR to a disposable Claude config
 * directory. Its refresh token will rotate and the resulting credentials will
 * remain in that directory.
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  parseCredentials,
  readAllClaudeAccounts,
  updateCredentialBlob,
} from "../dist/keychain.js"

const REQUIRED_VERSION = "opencode2 v0.0.0-beta-18381"
const CLI_PACKAGE = "@opencode-ai/cli@0.0.0-beta-18381"
const MODEL =
  process.env.CLAUDE_AUTH_HEADLESS_MODEL ?? "anthropic/claude-haiku-4-5"
const SENTINEL = `HEADLESS_${randomUUID().replaceAll("-", "")}`
const root = mkdtempSync(join(tmpdir(), "opencode-claude-auth-v2-"))
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const refreshConfigDir = process.env.CLAUDE_AUTH_HEADLESS_REFRESH_CONFIG_DIR

function fail(message: string, result?: ReturnType<typeof spawnSync>): never {
  if (result?.stdout) process.stderr.write(String(result.stdout))
  if (result?.stderr) process.stderr.write(String(result.stderr))
  throw new Error(message)
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = repo,
): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180_000,
  })
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.status}`, result)
  }
  return result.stdout ?? ""
}

function writeFileCredential(configDir: string, raw: string): void {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, ".credentials.json"), raw, { mode: 0o600 })
}

function prepareCredentialSource(): {
  configDir: string
  initialAccess: string
  refreshExpected: boolean
} {
  if (refreshConfigDir) {
    const path = join(refreshConfigDir, ".credentials.json")
    const raw = readFileSync(path, "utf8")
    const credentials = parseCredentials(raw)
    if (!credentials) fail(`Invalid disposable credentials at ${path}`)
    const updated = updateCredentialBlob(raw, {
      ...credentials,
      expiresAt: Date.now() + 1_000,
    })
    if (!updated) fail(`Could not update disposable credentials at ${path}`)
    writeFileCredential(refreshConfigDir, updated)
    return {
      configDir: refreshConfigDir,
      initialAccess: credentials.accessToken,
      refreshExpected: true,
    }
  }

  const source = readAllClaudeAccounts()[0]
  if (!source) {
    fail(
      "No Claude Code credentials found. Run `claude` before this smoke test.",
    )
  }
  if (source.credentials.expiresAt < Date.now() + 5 * 60_000) {
    fail("Claude credentials expire within five minutes. Run `claude` first.")
  }
  const configDir = join(root, "claude")
  writeFileCredential(
    configDir,
    JSON.stringify({ claudeAiOauth: source.credentials }),
  )
  return {
    configDir,
    initialAccess: source.credentials.accessToken,
    refreshExpected: false,
  }
}

function collectAnthropicModels(
  value: unknown,
  out: Array<{ cost: unknown[] }>,
): void {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) collectAnthropicModels(item, out)
    return
  }
  const record = value as Record<string, unknown>
  if (record.providerID === "anthropic" && Array.isArray(record.cost)) {
    out.push(record as { cost: unknown[] })
  }
  for (const item of Object.values(record)) collectAnthropicModels(item, out)
}

function main(): void {
  const cliDir = join(root, "cli")
  mkdirSync(cliDir, { recursive: true })
  run("npm", ["install", "--prefix", cliDir, CLI_PACKAGE], process.env)
  const opencode = join(cliDir, "node_modules", ".bin", "opencode2")
  const version = run(opencode, ["--version"], process.env).trim()
  if (version !== REQUIRED_VERSION) {
    fail(`Expected ${REQUIRED_VERSION}, found ${version}`)
  }

  const source = prepareCredentialSource()
  const packageDir = join(root, "package")
  const installDir = join(root, "install")
  const configHome = join(root, "config")
  const dataHome = join(root, "data")
  const cacheHome = join(root, "cache")
  const workDir = join(root, "work")
  const binDir = join(root, "bin")
  for (const dir of [
    packageDir,
    installDir,
    configHome,
    dataHome,
    cacheHome,
    workDir,
    binDir,
  ]) {
    mkdirSync(dir, { recursive: true })
  }

  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--json", "--pack-destination", packageDir],
      process.env,
    ),
  ) as Array<{ filename: string }>
  const tarball = join(packageDir, packed[0].filename)
  run(
    "npm",
    ["install", "--ignore-scripts", "--prefix", installDir, tarball],
    process.env,
  )
  const installedPlugin = join(
    installDir,
    "node_modules",
    "opencode-claude-auth",
  )

  mkdirSync(join(configHome, "opencode"), { recursive: true })
  writeFileSync(
    join(configHome, "opencode", "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      plugins: [join(installedPlugin, "dist", "index.js")],
    }),
  )
  writeFileSync(join(workDir, "smoke.txt"), SENTINEL)

  const security = join(binDir, "security")
  writeFileSync(
    security,
    `#!/bin/sh
if [ "$1" = "dump-keychain" ]; then exit 0; fi
exit 44
`,
  )
  chmodSync(security, 0o755)

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_CACHE_HOME: cacheHome,
    CLAUDE_CONFIG_DIR: source.configDir,
    CLAUDE_AUTH_DEBUG: join(root, "plugin.log"),
    OPENCODE_CLAUDE_AUTH_SECURITY_BIN: security,
  }

  const login = run(
    opencode,
    ["auth", "login", "anthropic", "--method", "claude-code", "--standalone"],
    env,
    workDir,
  )
  if (/https?:\/\//.test(login))
    fail("Auto import unexpectedly displayed a URL")

  const auth = run(opencode, ["auth", "list", "--standalone"], env, workDir)
  if (!/Claude(?: (?:Pro|Max|Team|Enterprise|Code))?(?:\s|$)/m.test(auth)) {
    fail("Imported Claude account label was not shown", {
      stdout: auth,
    } as ReturnType<typeof spawnSync>)
  }

  const modelsRaw = run(
    opencode,
    ["api", "--standalone", "get", "/api/model"],
    env,
    workDir,
  )
  const models: Array<{ cost: unknown[] }> = []
  collectAnthropicModels(JSON.parse(modelsRaw), models)
  if (models.length === 0 || models.some((model) => model.cost.length !== 0)) {
    fail("Anthropic subscription models did not have zeroed costs")
  }

  const output = run(
    opencode,
    [
      "run",
      "--standalone",
      "--auto",
      "--format",
      "json",
      "--model",
      MODEL,
      `Use the read tool to read ${join(workDir, "smoke.txt")}, then reply with exactly the file contents.`,
    ],
    env,
    workDir,
  )
  if (
    !output.includes(SENTINEL) ||
    !output.includes('"type":"tool_use"') ||
    !output.includes('"tool":"mcp_Read"')
  ) {
    process.stderr.write(output)
    fail("Tool round trip did not return the sentinel")
  }

  const current = parseCredentials(
    readFileSync(join(source.configDir, ".credentials.json"), "utf8"),
  )
  if (
    source.refreshExpected &&
    (!current ||
      current.accessToken === source.initialAccess ||
      current.expiresAt < Date.now() + 5 * 60_000)
  ) {
    fail("Near-expiry refresh did not rotate and write back credentials")
  }

  console.log(`Packed OpenCode v2 smoke test passed with ${MODEL}`)
}

try {
  main()
} finally {
  if (process.env.HEADLESS_KEEP) {
    console.log(`HEADLESS_KEEP set; sandbox preserved at ${root}`)
  } else {
    rmSync(root, { recursive: true, force: true })
  }
}
