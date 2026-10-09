import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import {
  lstat,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { errorMessage, log } from "./logger.ts"

export interface ClaudeCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType?: string
}

export interface ClaudeAccount {
  label: string
  source: string
  configDir?: string
  credentials: ClaudeCredentials
}

export const PRIMARY_SERVICE = "Claude Code-credentials"

/** Service names the Claude CLI creates. Anything else is not ours to touch. */
const KEYCHAIN_SERVICE_PATTERN = /^Claude Code-credentials(-[0-9a-f]+)?$/

/**
 * Whether `source` names a credential store this plugin owns. Credential
 * metadata round-trips through OpenCode's store, so this is checked where the
 * value re-enters (`readMetadata`) rather than at each of the several places
 * that later hand it to a subprocess.
 */
export function isKnownCredentialSource(source: string): boolean {
  return source === "file" || KEYCHAIN_SERVICE_PATTERN.test(source)
}

/** Enumerating every Keychain item is slower than fetching one by service. */
const SECURITY_DISCOVERY_TIMEOUT_MS = 5_000
const SECURITY_READ_TIMEOUT_MS = 2_000
/**
 * Every call on the write path, including the account lookup that precedes
 * the write, gets a far larger budget than a standalone read. A read that
 * times out costs a retry; a write that times out after the token exchange
 * already consumed the source's refresh token leaves the store holding a
 * dead credential.
 */
const SECURITY_WRITE_PATH_TIMEOUT_MS = 15_000

function securityBinary(): string {
  return process.env.OPENCODE_CLAUDE_AUTH_SECURITY_BIN ?? "/usr/bin/security"
}

interface SecurityOptions {
  timeout: number
  input?: string
  maxBuffer?: number
}

/** Run the macOS `security` tool without blocking the event loop. */
function security(args: string[], options: SecurityOptions): Promise<string> {
  return new Promise((settle, reject) => {
    const child = execFile(
      securityBinary(),
      args,
      {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        encoding: "utf-8",
      },
      (error, stdout) => (error ? reject(error) : settle(stdout)),
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

/** The config directory the Claude CLI uses when CLAUDE_CONFIG_DIR is unset. */
function primaryConfigDir(): string {
  return join(homedir(), ".claude")
}

/** `configDir`, else CLAUDE_CONFIG_DIR, else the primary directory, resolved. */
function defaultConfigDir(configDir?: string): string {
  return resolve(
    configDir ?? process.env.CLAUDE_CONFIG_DIR ?? primaryConfigDir(),
  )
}

export function parseCredentials(raw: string): ClaudeCredentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null

  const data = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth ?? parsed
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const creds = data as {
    accessToken?: unknown
    refreshToken?: unknown
    expiresAt?: unknown
    subscriptionType?: unknown
  }

  log("credentials_parsed", {
    hasAccessToken: typeof creds.accessToken === "string",
    hasRefreshToken: typeof creds.refreshToken === "string",
    hasExpiry: typeof creds.expiresAt === "number",
    isMcpOnly:
      !creds.accessToken && (parsed as { mcpOAuth?: unknown }).mcpOAuth != null,
  })
  if (
    typeof creds.accessToken !== "string" ||
    creds.accessToken.trim().length === 0 ||
    typeof creds.refreshToken !== "string" ||
    creds.refreshToken.trim().length === 0 ||
    typeof creds.expiresAt !== "number" ||
    !Number.isFinite(creds.expiresAt) ||
    creds.expiresAt <= 0
  ) {
    return null
  }

  return {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: Math.trunc(creds.expiresAt),
    subscriptionType:
      typeof creds.subscriptionType === "string"
        ? creds.subscriptionType
        : undefined,
  }
}

async function readKeychainService(
  serviceName: string,
): Promise<string | null> {
  try {
    const result = (
      await security(["find-generic-password", "-s", serviceName, "-w"], {
        timeout: SECURITY_READ_TIMEOUT_MS,
      })
    ).trim()
    log("keychain_read", { service: serviceName, success: true })
    return result
  } catch (err: unknown) {
    // execFile reports the exit status in `code`; a timeout sets `killed`.
    const error = err as { code?: number | string; killed?: boolean }

    if (error.killed || error.code === "ETIMEDOUT") {
      log("keychain_read_error", {
        service: serviceName,
        errorType: "timeout",
      })
      throw new Error(
        "Keychain read timed out. This can happen on macOS Tahoe. Try restarting Keychain Access.",
        { cause: err },
      )
    }
    if (error.code === 36) {
      log("keychain_read_error", {
        service: serviceName,
        errorType: "locked",
      })
      throw new Error(
        "macOS Keychain is locked. Please unlock it or run: security unlock-keychain ~/Library/Keychains/login.keychain-db",
        { cause: err },
      )
    }
    if (error.code === 128) {
      log("keychain_read_error", {
        service: serviceName,
        errorType: "denied",
      })
      throw new Error(
        "Keychain access was denied. Please grant access when prompted by macOS.",
        { cause: err },
      )
    }
    if (error.code === 44) {
      log("keychain_read_error", {
        service: serviceName,
        errorType: "not_found",
      })
      return null
    }
    log("keychain_read_error", {
      service: serviceName,
      errorType: `exit_${error.code ?? "unknown"}`,
    })
    throw new Error(
      `Failed to read Keychain entry "${serviceName}" (exit ${error.code ?? "unknown"}). Try re-authenticating with Claude Code.`,
      { cause: err },
    )
  }
}

async function listClaudeKeychainServices(): Promise<string[]> {
  try {
    const dump = await security(["dump-keychain"], {
      timeout: SECURITY_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 10, // 10 MB
    })

    // Any-length hex suffix so legacy entries stay discoverable. The
    // suffix-to-config-dir mapping below still only applies to the
    // 8-char hashes the Claude CLI generates.
    const re = /"(Claude Code-credentials(?:-[0-9a-f]+)?)"/g
    const found = new Set([...dump.matchAll(re)].map((m) => m[1]))
    const ordered = [
      ...(found.has(PRIMARY_SERVICE) ? [PRIMARY_SERVICE] : []),
      ...[...found].filter((svc) => svc !== PRIMARY_SERVICE),
    ]
    log("keychain_list", { servicesFound: ordered })
    return ordered
  } catch (err) {
    log("keychain_list", {
      error: errorMessage(err),
    })
    return [PRIMARY_SERVICE]
  }
}

function readEmailFromConfigDir(configDir: string): string | null {
  const candidates = [
    join(configDir, ".claude.json"),
    ...(configDir === primaryConfigDir()
      ? [join(homedir(), ".claude.json")]
      : []),
  ]

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8")
      const data = JSON.parse(raw) as {
        oauthAccount?: { emailAddress?: string }
      }
      const email = data.oauthAccount?.emailAddress
      if (email) return email
    } catch {
      // try next candidate
    }
  }

  return null
}

export async function readCredentialsFile(
  configDir = defaultConfigDir(),
): Promise<ClaudeCredentials | null> {
  try {
    const credPath = join(configDir, ".credentials.json")
    const raw = await readFile(credPath, "utf-8")
    const creds = parseCredentials(raw)
    log("credentials_file_read", { success: creds !== null, configDir })
    return creds
  } catch {
    log("credentials_file_read", { success: false, configDir })
    return null
  }
}

/** The account in the configured credentials file, if any. */
async function fileAccounts(): Promise<ClaudeAccount[]> {
  const configDir = defaultConfigDir()
  const creds = await readCredentialsFile(configDir)
  if (!creds) return []
  const email = readEmailFromConfigDir(configDir)
  const [label] = buildAccountLabels([creds], [email])
  return [{ label, source: "file", configDir, credentials: creds }]
}

export function keychainSuffixForDir(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 8)
}

let suffixToDirCache: Map<string, string> | null = null

function buildSuffixToDirCache(needed: Set<string>): Map<string, string> {
  const hasAllNeeded = (cache: Map<string, string>) =>
    [...needed].every((suffix) => cache.has(suffix))

  if (suffixToDirCache && hasAllNeeded(suffixToDirCache))
    return suffixToDirCache

  const cache = suffixToDirCache ?? new Map<string, string>()

  const tryDir = (dir: string) => {
    const suffix = keychainSuffixForDir(dir)
    if (needed.has(suffix) && !cache.has(suffix)) cache.set(suffix, dir)
  }

  if (process.env.CLAUDE_CONFIG_DIR) {
    tryDir(process.env.CLAUDE_CONFIG_DIR)
  }

  const home = homedir()
  try {
    const entries = readdirSync(home, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(".")) continue
      const dir = join(home, entry.name)
      if (!existsSync(join(dir, ".claude.json"))) continue
      tryDir(dir)
      if (hasAllNeeded(cache)) break
    }
  } catch {
    //
  }

  suffixToDirCache = cache
  return cache
}

export function clearSuffixToDirCache(): void {
  suffixToDirCache = null
}

export function buildAccountLabels(
  credsList: ClaudeCredentials[],
  emails?: (string | null)[],
  sources?: (string | null)[],
): string[] {
  const baseLabels = credsList.map((c) => {
    if (c.subscriptionType) {
      const tier =
        c.subscriptionType.charAt(0).toUpperCase() + c.subscriptionType.slice(1)
      return `Claude ${tier}`
    }
    return "Claude"
  })

  const counts = new Map<string, number>()
  for (const l of baseLabels) counts.set(l, (counts.get(l) ?? 0) + 1)

  const seen = new Map<string, number>()
  return baseLabels.map((base, i) => {
    let label: string
    if ((counts.get(base) ?? 0) <= 1) {
      label = base
    } else {
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      label = `${base} ${n}`
    }
    const email = emails?.[i]
    if (email) return `${label}: ${email}`
    const source = sources?.[i]
    return source ? `${label}: ${source}` : label
  })
}

/**
 * Every Claude Code account on this machine. One inaccessible Keychain entry
 * does not hide the others; its error surfaces only when no account could be
 * read at all, so a locked Keychain is reported rather than shown as "no
 * credentials".
 */
export async function readAllClaudeAccounts(): Promise<ClaudeAccount[]> {
  if (process.platform !== "darwin") return fileAccounts()

  const services = await listClaudeKeychainServices()
  const keychainAccounts: Array<{
    source: string
    suffix: string | null
    credentials: ClaudeCredentials
  }> = []
  let firstError: unknown

  for (const svc of services) {
    let raw: string | null
    try {
      raw = await readKeychainService(svc)
    } catch (error) {
      firstError ??= error
      continue
    }
    if (!raw) continue
    const creds = parseCredentials(raw)
    if (!creds) continue
    const suffixMatch = svc.match(/-([0-9a-f]{8})$/)
    keychainAccounts.push({
      source: svc,
      suffix: suffixMatch ? suffixMatch[1] : null,
      credentials: creds,
    })
  }

  if (keychainAccounts.length === 0) {
    if (firstError !== undefined) throw firstError
    return fileAccounts()
  }

  const suffixToDir = buildSuffixToDirCache(
    new Set(
      keychainAccounts
        .map((a) => a.suffix)
        .filter((s): s is string => s !== null),
    ),
  )

  const resolved = keychainAccounts.map((a) => {
    const configDir =
      a.source === PRIMARY_SERVICE
        ? primaryConfigDir()
        : a.suffix
          ? suffixToDir.get(a.suffix)
          : undefined
    const email = configDir ? readEmailFromConfigDir(configDir) : null
    log("account_config_dir", {
      source: a.source,
      configDir: configDir ?? null,
    })
    return {
      source: a.source,
      credentials: a.credentials,
      configDir,
      email,
    }
  })

  const labels = buildAccountLabels(
    resolved.map((a) => a.credentials),
    resolved.map((a) => a.email),
    resolved.map((a) => a.source),
  )

  return resolved.map((a, i) => {
    const account: ClaudeAccount = {
      label: labels[i],
      source: a.source,
      credentials: a.credentials,
    }
    if (a.configDir) account.configDir = a.configDir
    return account
  })
}

export function credentialSourceID(source: string, configDir?: string): string {
  if (source !== "file") return `keychain:${source}`
  return `file:${defaultConfigDir(configDir)}`
}

export function updateCredentialBlob(
  existingJson: string,
  newCreds: { accessToken: string; refreshToken: string; expiresAt: number },
): string | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(existingJson)
  } catch {
    return null
  }

  const wrapper = parsed.claudeAiOauth as Record<string, unknown> | undefined
  const target = wrapper ?? parsed

  target.accessToken = newCreds.accessToken
  target.refreshToken = newCreds.refreshToken
  target.expiresAt = newCreds.expiresAt

  return JSON.stringify(parsed)
}

/**
 * The `acct` attribute of a Keychain item. `security` renders it as a C-style
 * quoted blob, so the capture has to honor backslash escapes: stopping at the
 * first backslash would yield a truncated name, and writing under a truncated
 * name forks a second Keychain item instead of updating this one.
 */
async function getKeychainAccountName(
  serviceName: string,
): Promise<string | null> {
  try {
    const output = await security(
      ["find-generic-password", "-s", serviceName],
      { timeout: SECURITY_WRITE_PATH_TIMEOUT_MS },
    )
    const match = /"acct"<blob>="((?:[^"\\]|\\.)*)"/.exec(output)
    if (match) {
      const account = match[1].replace(/\\(.)/g, "$1")
      log("keychain_account_name", { service: serviceName, account })
      return account
    }
    return null
  } catch {
    return null
  }
}

/**
 * A short, non-reversible tag for an access token, so write-back decisions
 * can be correlated across log lines (and against another account's) without
 * putting token material in the log.
 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32)
}

/**
 * `failed` is a decision about the stored blob and will not change on a
 * retry. `unavailable` means the store could not be reached at all, which is
 * the only outcome worth attempting again.
 */
export type WriteBackResult = "written" | "conflict" | "failed" | "unavailable"

/**
 * Whether a stored credential blob still carries the access token we expect.
 *
 * Guards write-back against an external switch landing between the read that
 * produced the token being refreshed and the re-read just before the write.
 * It does not cover the remaining window: for the Keychain store that window
 * still contains an entire `getKeychainAccountName` subprocess. An
 * unparseable blob returns false: a write into state we cannot identify is
 * exactly what this is meant to prevent.
 *
 * Deliberately stricter than the write it guards: this validates through
 * parseCredentials (field types, mcpOAuth-only rejection) while
 * updateCredentialBlob rewrites anything JSON.parse accepts. So a blob the
 * write path would happily update can still be refused here. That gap is
 * intentional — reaching this guard means an earlier parseCredentials
 * succeeded, so a blob that no longer parses changed shape after we read it
 * (a truncated non-atomic external write, or a hand edit), and declining to
 * write over it is correct. Anyone tightening parseCredentials should know it
 * narrows write-back too, not just reads.
 */
export function credentialBlobMatches(
  raw: string,
  expectedAccessToken: string,
): boolean {
  const parsed = parseCredentials(raw)
  return parsed?.accessToken === expectedAccessToken
}

interface CredentialStore {
  /** Log context for every event this store emits. */
  fields: Record<string, unknown>
  read(): Promise<string | null>
  write(blob: string): Promise<void>
}

const TEMP_PREFIX = ".credentials.json."
const TEMP_SUFFIX = ".tmp"
const TEMP_SWEEP_AGE_MS = 60 * 60 * 1000

/**
 * Drop temp blobs a killed process left behind. They hold a full token pair,
 * so they are not something to leave in the config directory indefinitely.
 */
async function sweepStaleTemps(dir: string): Promise<void> {
  try {
    const names = await readdir(dir)
    const now = Date.now()
    await Promise.all(
      names.map(async (name) => {
        if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) return
        const path = join(dir, name)
        const info = await lstat(path).catch(() => null)
        if (info && now - info.mtimeMs > TEMP_SWEEP_AGE_MS) {
          await unlink(path).catch(() => {})
        }
      }),
    )
  } catch {
    // Sweeping is opportunistic; the write is what matters.
  }
}

/** fsync the directory so the rename itself survives a crash. */
async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r").catch(() => null)
  if (!handle) return
  try {
    await handle.sync()
  } catch {
    // Not supported on every platform; the rename still lands.
  } finally {
    await handle.close().catch(() => {})
  }
}

function fileStore(configDir: string | undefined): CredentialStore {
  const dir = defaultConfigDir(configDir)
  const credPath = join(dir, ".credentials.json")
  return {
    fields: { source: "file", configDir: dir },
    // Null for "nothing stored", matching the Keychain store, so an absent
    // file reads as a decision rather than as an unreachable store.
    read: async () => {
      try {
        return await readFile(credPath, "utf-8")
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR") return null
        throw error
      }
    },
    async write(blob) {
      const tempPath = join(
        dir,
        `${TEMP_PREFIX}${process.pid}.${randomUUID()}${TEMP_SUFFIX}`,
      )
      try {
        const handle = await open(tempPath, "wx", 0o600)
        try {
          await handle.writeFile(blob, "utf-8")
          if (process.platform !== "win32") await handle.chmod(0o600)
          // Flush before publishing. A rename is atomic for concurrent
          // readers but says nothing about durability: without this, a crash
          // can leave the new directory entry pointing at unwritten data, and
          // the user's credentials file comes back empty.
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(tempPath, credPath)
        await syncDirectory(dir)
      } finally {
        await unlink(tempPath).catch(() => {
          // Already renamed into place, or never created.
        })
      }
      // After the rename, not before: the window between the token exchange
      // and the credential landing is the dangerous one, and nothing here
      // needs to happen inside it.
      await sweepStaleTemps(dir)
    },
  }
}

function keychainStore(source: string): CredentialStore {
  return {
    fields: { source },
    read: () => readKeychainService(source),
    async write(blob) {
      // `add-generic-password -U` keys on service plus account. Guessing the
      // account would create a second item instead of updating this one.
      const accountName = await getKeychainAccountName(source)
      if (accountName === null) {
        throw new Error(`Keychain account name for "${source}" was not found`)
      }
      await security(
        ["add-generic-password", "-s", source, "-a", accountName, "-U", "-w"],
        { timeout: SECURITY_WRITE_PATH_TIMEOUT_MS, input: `${blob}\n` },
      )
    },
  }
}

/**
 * Why a stored blob must not be overwritten, or null when it may be. Two
 * operationally opposite causes share the refusal: another account
 * legitimately holds the slot (benign, no action) versus a blob we cannot
 * read at all (corruption, needs a human). Same result kind, different events.
 */
function refuseWrite(
  blob: string,
  fields: Record<string, unknown>,
): WriteBackResult {
  const stored = parseCredentials(blob)
  log(
    stored ? "writeback_skipped_stale" : "writeback_skipped_unparseable",
    stored
      ? { ...fields, stored: tokenFingerprint(stored.accessToken) }
      : fields,
  )
  return stored ? "conflict" : "failed"
}

function staleBlobResult(
  raw: string,
  expectedAccessToken: string | undefined,
  fields: Record<string, unknown>,
): WriteBackResult | null {
  if (
    expectedAccessToken === undefined ||
    credentialBlobMatches(raw, expectedAccessToken)
  ) {
    return null
  }
  return refuseWrite(raw, {
    ...fields,
    expected: tokenFingerprint(expectedAccessToken),
  })
}

/**
 * Guarded write of refreshed tokens into the source they came from. The blob
 * is re-read just before the write and the write is declined when it changed
 * underneath, which preserves unrelated concurrent edits and source
 * rotations that land before the re-read.
 *
 * This is not atomic. The re-read and the write are separate operations, and
 * the Claude CLI does not take this plugin's refresh lock, so a rotation it
 * makes in that window is overwritten. The plugin's own refreshes are
 * serialized by the refresh lock, so only external writers race here.
 */
export async function writeBackCredentials(
  source: string,
  creds: ClaudeCredentials,
  configDir?: string,
  expectedPriorAccessToken?: string,
): Promise<WriteBackResult> {
  const store = storeFor(source, configDir)
  if (!store) return "failed"

  try {
    const raw = await store.read()
    if (raw === null) return "failed"
    const stale = staleBlobResult(raw, expectedPriorAccessToken, store.fields)
    if (stale) return stale
    const updated = updateCredentialBlob(raw, creds)
    if (!updated) return "failed"

    const latest = await store.read()
    if (latest === null) return "failed"
    if (latest !== raw) return refuseWrite(latest, store.fields)

    await store.write(updated)
    log("writeback_success", store.fields)
    return "written"
  } catch (error) {
    // Only this branch is worth retrying: everything above is a decision
    // about the stored blob, and repeating it reaches the same conclusion.
    log("writeback_failed", { ...store.fields, error: errorMessage(error) })
    return "unavailable"
  }
}

/** The store `source` names, or null when it names nothing writable. */
function storeFor(
  source: string,
  configDir: string | undefined,
): CredentialStore | null {
  if (source === "file") return fileStore(configDir)
  if (process.platform !== "darwin") return null
  if (!isKnownCredentialSource(source)) {
    // `source` round-trips through OpenCode's credential store, so it is not
    // trusted to still name a Claude Code item by the time it comes back.
    log("writeback_rejected_source", { source })
    return null
  }
  return keychainStore(source)
}

export async function refreshAccount(
  source: string,
  configDir?: string,
): Promise<ClaudeCredentials | null> {
  if (source === "file") {
    return readCredentialsFile(configDir)
  }
  const raw = await readKeychainService(source)
  if (!raw) return null
  return parseCredentials(raw)
}
