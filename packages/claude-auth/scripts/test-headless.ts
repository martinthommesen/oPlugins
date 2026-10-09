/**
 * Manual packed-package smoke test for OpenCode v2.
 *
 * Pass --offline to test plugin loading, import, and pricing with a fake
 * credential and a local mock API, without reading real credentials or
 * contacting Anthropic.
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
import { spawn } from "node:child_process"
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
import { fileURLToPath, pathToFileURL } from "node:url"
import { REQUIRED_HOST_VERSION } from "../dist/index.js"
import {
  parseCredentials,
  readAllClaudeAccounts,
  updateCredentialBlob,
} from "../dist/keychain.js"
import { startMockAnthropic } from "./mock-anthropic.ts"

const requestedHost = process.env.CLAUDE_AUTH_HEADLESS_HOST_VERSION
const HOST_VERSION =
  requestedHost && requestedHost !== "target"
    ? requestedHost
    : REQUIRED_HOST_VERSION
const REQUIRED_VERSION = `opencode v${HOST_VERSION}`
const CLI_PACKAGE = `@opencode/cli@${HOST_VERSION}`
const offline = process.argv.includes("--offline")
// A model that requires the pinned Claude Code version and takes the effort
// beta, so the smoke run covers what a version or beta change can break.
const MODEL =
  process.env.CLAUDE_AUTH_HEADLESS_MODEL ?? "anthropic/claude-sonnet-5-5"
const customModel = process.env.CLAUDE_AUTH_HEADLESS_CUSTOM_MODEL === "1"
const SENTINEL = `HEADLESS_${randomUUID().replaceAll("-", "")}`
const root = mkdtempSync(join(tmpdir(), "opencode-claude-auth-v2-"))
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const refreshConfigDir = process.env.CLAUDE_AUTH_HEADLESS_REFRESH_CONFIG_DIR

function fail(
  message: string,
  result?: { stdout: string; stderr: string },
): never {
  if (result?.stdout) process.stderr.write(String(result.stdout))
  if (result?.stderr) process.stderr.write(String(result.stderr))
  throw new Error(message)
}

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = repo,
): Promise<string> {
  const child = spawn(command, args, {
    cwd,
    env,
    timeout: 180_000,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const result = { stdout: "", stderr: "" }
  child.stdout.setEncoding("utf8").on("data", (data) => {
    result.stdout += data
  })
  child.stderr.setEncoding("utf8").on("data", (data) => {
    result.stderr += data
  })
  return new Promise((complete, reject) => {
    child.once("error", reject)
    child.once("close", (status) => {
      if (status !== 0) {
        process.stderr.write(result.stdout + result.stderr)
        reject(new Error(`${command} ${args.join(" ")} exited ${status}`))
      } else {
        complete(result.stdout)
      }
    })
  })
}

function writeFileCredential(configDir: string, raw: string): void {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, ".credentials.json"), raw, { mode: 0o600 })
}

async function prepareCredentialSource(): Promise<{
  configDir: string
  initialAccess: string
  refreshExpected: boolean
}> {
  if (offline) {
    const configDir = join(root, "claude")
    writeFileCredential(
      configDir,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "offline-test-access",
          refreshToken: "offline-test-refresh",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    )
    return {
      configDir,
      initialAccess: "offline-test-access",
      refreshExpected: false,
    }
  }

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

  const source = (await readAllClaudeAccounts())[0]
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

async function main(): Promise<void> {
  const cliDir = join(root, "cli")
  mkdirSync(cliDir, { recursive: true })
  await run("npm", ["install", "--prefix", cliDir, CLI_PACKAGE], process.env)
  const opencode = join(cliDir, "node_modules", ".bin", "opencode")
  const version = (await run(opencode, ["--version"], process.env)).trim()
  if (version !== REQUIRED_VERSION) {
    fail(`Expected ${REQUIRED_VERSION}, found ${version}`)
  }

  const source = await prepareCredentialSource()
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
    await run(
      "npm",
      ["pack", "--json", "--pack-destination", packageDir],
      process.env,
    ),
  ) as Array<{ filename: string }>
  const tarball = join(packageDir, packed[0].filename)
  await run(
    "npm",
    ["install", "--ignore-scripts", "--prefix", installDir, tarball],
    process.env,
  )
  const installedPlugin = join(
    installDir,
    "node_modules",
    "opencode-claude-auth",
  )

  const pluginsDir = join(configHome, "opencode", "plugins")
  const modelsPath = join(root, "models.json")
  mkdirSync(pluginsDir, { recursive: true })
  // Read the host's models after setup. Standalone API reads do not activate
  // plugins in the supported hosts; auth/run commands do, as a normal client does.
  writeFileSync(
    join(pluginsDir, "claude-auth.js"),
    `import plugin from ${JSON.stringify(pathToFileURL(join(installedPlugin, "dist", "index.js")).href)}
import { writeFileSync } from "node:fs"
export default {
  ...plugin,
  async setup(ctx) {
    const cleanup = await plugin.setup(ctx)
    if (${offline}) await ctx.session.hook("http.request", (event) => {
      event.request.headers.set("x-claude-auth-test-kind", event.kind)
    }, { providerID: "anthropic" })
    const { data: models } = await ctx.model.list()
    writeFileSync(${JSON.stringify(modelsPath)}, JSON.stringify(
      models.map(({ providerID, cost }) => ({ providerID, cost }))
    ))
    return cleanup
  }
}
`,
  )
  const mock = offline
    ? await startMockAnthropic(SENTINEL, join(workDir, "smoke.txt"))
    : undefined
  try {
    writeFileSync(
      join(configHome, "opencode", "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        update: "disable",
        ...(mock
          ? {
              providers: {
                anthropic: {
                  settings: { baseURL: mock.baseURL },
                  ...(customModel
                    ? {
                        models: {
                          [MODEL.replace(/^anthropic\//, "")]: {
                            capabilities: {
                              tools: true,
                              input: ["text", "image"],
                              output: ["text"],
                            },
                            limit: { context: 1_000_000, output: 128_000 },
                          },
                        },
                      }
                    : {}),
                },
              },
              agents: { title: { model: MODEL } },
            }
          : {}),
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
      XDG_STATE_HOME: join(root, "state"),
      CLAUDE_CONFIG_DIR: source.configDir,
      CLAUDE_AUTH_DEBUG: join(root, "plugin.log"),
      OPENCODE_CLAUDE_AUTH_SECURITY_BIN: security,
    }

    const login = await run(
      opencode,
      ["auth", "login", "anthropic", "--method", "claude-code", "--standalone"],
      env,
      workDir,
    )
    if (/https?:\/\//.test(login))
      fail("Auto import unexpectedly displayed a URL")

    const auth = await run(
      opencode,
      ["auth", "list", "--standalone"],
      env,
      workDir,
    )
    if (!/Claude(?: (?:Pro|Max|Team|Enterprise|Code))?(?:\s|$)/m.test(auth)) {
      process.stderr.write(auth)
      fail("Imported Claude account label was not shown")
    }

    const modelsRaw = readFileSync(modelsPath, "utf8")
    const models: Array<{ cost: unknown[] }> = []
    collectAnthropicModels(JSON.parse(modelsRaw), models)
    if (
      models.length === 0 ||
      models.some((model) => model.cost.length !== 0)
    ) {
      fail("Anthropic subscription models did not have zeroed costs")
    }

    const output = await run(
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
      !output.includes('"tool":"read"') ||
      output.includes('"tool":"mcp_')
    ) {
      process.stderr.write(output)
      fail("Tool round trip did not return the sentinel under OpenCode names")
    }

    if (mock) {
      mock.verify()
      console.log(
        `Packed OpenCode ${HOST_VERSION} offline tool round trip passed with ${MODEL}${customModel ? " (custom model)" : ""}`,
      )
      return
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
  } finally {
    await mock?.close()
  }
}

try {
  await main()
} finally {
  if (process.env.HEADLESS_KEEP) {
    console.log(`HEADLESS_KEEP set; sandbox preserved at ${root}`)
  } else {
    rmSync(root, { recursive: true, force: true })
  }
}
