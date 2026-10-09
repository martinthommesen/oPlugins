import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
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
import { isRecord, parseJsonRecord } from "./json.ts"
import { errorMessage, log, warn } from "./logger.ts"

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
 * metadata round-trips through OpenCode's store, so `readMetadata` checks it
 * on the way back in, and `storeFor` again before anything reaches a
 * subprocess.
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
  const parsed = parseJsonRecord(raw)
  if (!parsed) return null
  const data = parsed.claudeAiOauth ?? parsed
  if (!isRecord(data)) return null
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
    isMcpOnly: !creds.accessToken && parsed.mcpOAuth != null,
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

/**
 * `find-generic-password -w` prints a password holding any byte outside
 * printable ASCII as bare hex. A credential blob is a JSON object, so output
 * that is all hex digits cannot be the blob itself.
 */
function decodePasswordOutput(output: string): string {
  return /^(?:[0-9a-f]{2})+$/.test(output)
    ? Buffer.from(output, "hex").toString("utf-8")
    : output
}

async function readKeychainService(
  serviceName: string,
  timeout = SECURITY_READ_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const result = decodePasswordOutput(
      (
        await security(["find-generic-password", "-s", serviceName, "-w"], {
          timeout,
        })
      ).trim(),
    )
    log("keychain_read", { service: serviceName, success: true })
    return result
  } catch (err: unknown) {
    // execFile reports the exit status in `code`; a timeout sets `killed`.
    const error = err as {
      code?: number | string
      killed?: boolean
      stderr?: string
    }
    const errorType =
      error.killed || error.code === "ETIMEDOUT"
        ? "timeout"
        : (KEYCHAIN_EXIT_TYPES.get(error.code) ??
          `exit_${error.code ?? "unknown"}`)
    log("keychain_read_error", { service: serviceName, errorType })
    if (errorType === "not_found") return null
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : ""
    throw new Error(
      KEYCHAIN_READ_ERRORS[errorType] ??
        `Unexpected failure reading Keychain item "${serviceName}" (${errorType}${stderr ? `: ${stderr}` : ""}).`,
      { cause: err },
    )
  }
}

/** `security` exit statuses with a known meaning. */
const KEYCHAIN_EXIT_TYPES = new Map<unknown, string>([
  [36, "locked"],
  [44, "not_found"],
  [128, "denied"],
])

const KEYCHAIN_READ_ERRORS: Record<string, string> = {
  timeout:
    "Keychain read timed out. This can happen on macOS Tahoe. Try restarting Keychain Access.",
  locked:
    "macOS Keychain is locked. Please unlock it or run: security unlock-keychain ~/Library/Keychains/login.keychain-db",
  denied:
    "Keychain access was denied. Please grant access when prompted by macOS.",
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
    // Nearly everyone has the primary item, so it is still worth trying. The
    // user is told, because accounts missing from /connect look like a bug.
    warn(
      "keychain_list_failed",
      `could not list Keychain items, so only the primary Claude Code account is offered: ${errorMessage(err)}`,
    )
    return [PRIMARY_SERVICE]
  }
}

async function readEmailFromConfigDir(
  configDir: string,
): Promise<string | null> {
  const candidates = [
    join(configDir, ".claude.json"),
    ...(configDir === primaryConfigDir()
      ? [join(homedir(), ".claude.json")]
      : []),
  ]

  for (const path of candidates) {
    const data = parseJsonRecord(await readFile(path, "utf-8").catch(() => ""))
    const account = data?.oauthAccount
    const email = isRecord(account) ? account.emailAddress : undefined
    if (typeof email === "string" && email) return email
  }

  return null
}

/**
 * The credentials in `configDir`, or null when there is no file or it holds
 * no usable credential. A file that exists but cannot be read throws, because
 * reporting a permission problem as "no credentials" sends the user to log in
 * again for nothing.
 */
export async function readCredentialsFile(
  configDir = defaultConfigDir(),
): Promise<ClaudeCredentials | null> {
  let raw: string | null
  try {
    raw = await fileStore(configDir).read()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    log("credentials_file_read", { success: false, configDir, code })
    throw error
  }
  const creds = raw === null ? null : parseCredentials(raw)
  log("credentials_file_read", {
    success: creds !== null,
    configDir,
    ...(raw === null ? { missing: true } : {}),
  })
  return creds
}

/** The account in the configured credentials file, if any. */
async function fileAccounts(): Promise<ClaudeAccount[]> {
  const configDir = defaultConfigDir()
  const creds = await readCredentialsFile(configDir)
  if (!creds) return []
  const email = await readEmailFromConfigDir(configDir)
  const [label] = buildAccountLabels([creds], [email])
  return [{ label, source: "file", configDir, credentials: creds }]
}

export function keychainSuffixForDir(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 8)
}

/**
 * The config directory each of `needed` suffixes hashes from. Claude Code
 * names a non-primary item after its config directory, and those directories
 * live in the home directory unless CLAUDE_CONFIG_DIR points elsewhere.
 */
function configDirsBySuffix(needed: Set<string>): Map<string, string> {
  const found = new Map<string, string>()
  const tryDir = (dir: string) => {
    const suffix = keychainSuffixForDir(dir)
    if (needed.has(suffix) && !found.has(suffix)) found.set(suffix, dir)
  }

  if (process.env.CLAUDE_CONFIG_DIR) tryDir(process.env.CLAUDE_CONFIG_DIR)

  const home = homedir()
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (found.size === needed.size) break
      if (!entry.isDirectory() || !entry.name.startsWith(".")) continue
      const dir = join(home, entry.name)
      if (existsSync(join(dir, ".claude.json"))) tryDir(dir)
    }
  } catch (error) {
    // Unmapped suffixes only lose their config directory and email label.
    log("suffix_scan_failed", { error: errorMessage(error) })
  }
  return found
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

/** The 8-character config-directory hash a non-primary service name ends in. */
function suffixOf(source: string): string | undefined {
  return /-([0-9a-f]{8})$/.exec(source)?.[1]
}

/**
 * Every Claude Code account on this machine. One inaccessible Keychain entry
 * does not hide the others; its error is reported only when no account could be
 * read at all, so a locked Keychain is reported rather than shown as "no
 * credentials". Entries without a usable credential (an mcpOAuth-only blob,
 * say) are skipped, and with none left the credentials file is tried.
 */
export async function readAllClaudeAccounts(): Promise<ClaudeAccount[]> {
  if (process.platform !== "darwin") return fileAccounts()

  const sources = await listClaudeKeychainServices()
  const reads = await Promise.allSettled(
    sources.map((source) => readKeychainService(source)),
  )
  const found: Array<{ source: string; credentials: ClaudeCredentials }> = []
  for (const [i, read] of reads.entries()) {
    const credentials =
      read.status === "fulfilled" && read.value
        ? parseCredentials(read.value)
        : null
    if (credentials) found.push({ source: sources[i], credentials })
  }

  if (found.length === 0) {
    const failed = reads.find((read) => read.status === "rejected")
    if (failed) throw failed.reason
    return fileAccounts()
  }

  const suffixToDir = configDirsBySuffix(
    new Set(
      found.map((a) => suffixOf(a.source)).filter((s) => s !== undefined),
    ),
  )
  const configDirs = found.map(({ source }) => {
    const suffix = suffixOf(source)
    const configDir =
      source === PRIMARY_SERVICE
        ? primaryConfigDir()
        : suffix
          ? suffixToDir.get(suffix)
          : undefined
    log("account_config_dir", { source, configDir: configDir ?? null })
    return configDir
  })
  const emails = await Promise.all(
    configDirs.map((dir) => (dir ? readEmailFromConfigDir(dir) : null)),
  )
  const labels = buildAccountLabels(
    found.map((a) => a.credentials),
    emails,
    found.map((a) => a.source),
  )

  return found.map(({ source, credentials }, i) => {
    const account: ClaudeAccount = { label: labels[i], source, credentials }
    const configDir = configDirs[i]
    if (configDir) account.configDir = configDir
    return account
  })
}

export function credentialSourceID(source: string, configDir?: string): string {
  if (source !== "file") return `keychain:${source}`
  return `file:${defaultConfigDir(configDir)}`
}

/**
 * `existingJson` with its tokens replaced and everything else kept, or null
 * when it is not a credential object this can safely edit.
 */
export function updateCredentialBlob(
  existingJson: string,
  newCreds: Pick<
    ClaudeCredentials,
    "accessToken" | "refreshToken" | "expiresAt"
  >,
): string | null {
  const parsed = parseJsonRecord(existingJson)
  if (!parsed) return null
  const wrapper = parsed.claudeAiOauth
  if (wrapper !== undefined && !isRecord(wrapper)) return null
  const target = wrapper ?? parsed

  target.accessToken = newCreds.accessToken
  target.refreshToken = newCreds.refreshToken
  target.expiresAt = newCreds.expiresAt

  // Escaped to ASCII so a Keychain item stays printable. `security` hands
  // back anything else as hex, which the Claude CLI may not expect.
  return JSON.stringify(parsed).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

/**
 * Parse the `acct` attribute out of `find-generic-password` output. A name of
 * printable ASCII without backslashes prints verbatim between quotes, with
 * inner quotes left unescaped, so the value runs to the last quote on the
 * line. Anything else prints as `0x<hex>` followed by an octal-escaped form,
 * and the hex is the exact name. Reading either form wrong yields a different
 * name, and `add-generic-password -U` under a different name creates a second
 * item instead of updating this one.
 */
function parseKeychainAccount(output: string): string | null {
  const hex = /"acct"<blob>=0x([0-9A-Fa-f]+)/.exec(output)
  if (hex) return Buffer.from(hex[1], "hex").toString("utf-8")
  const quoted = /"acct"<blob>="(.*)"[ \t]*$/m.exec(output)
  return quoted ? quoted[1] : null
}

/**
 * The account name of a Keychain item, or null when there is no such item or
 * it has no account. A failure to reach the Keychain throws rather than
 * reading as "no account", so the caller can tell a locked Keychain from a
 * missing or malformed item.
 */
async function getKeychainAccountName(
  serviceName: string,
): Promise<string | null> {
  let output: string
  try {
    output = await security(["find-generic-password", "-s", serviceName], {
      timeout: SECURITY_WRITE_PATH_TIMEOUT_MS,
    })
  } catch (error) {
    if (
      KEYCHAIN_EXIT_TYPES.get((error as { code?: unknown }).code) ===
      "not_found"
    ) {
      return null
    }
    throw error
  }
  const account = parseKeychainAccount(output)
  log("keychain_account_name", { service: serviceName, account })
  return account
}

/**
 * Longest line `security -i` reads as one command, newline included. A longer
 * line is split into fragments and the first one still runs, so writing an
 * over-long command this way stores a truncated blob.
 */
const SECURITY_INTERACTIVE_LINE_MAX = 4096

/** Quote an argument for `security -i`, which honors quotes and backslashes. */
function interactiveArg(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`
}

/**
 * Store `blob` as the password of an existing item. The password goes in as
 * hex through `-X`, never through a trailing `-w`. That form prompts twice
 * through getpass, which reads stdin when there is no terminal, keeps 128
 * characters, and accepts two empty entries, so a piped blob is stored as an
 * empty password while `security` exits 0.
 *
 * The command goes to `security -i` on stdin, so the tokens stay out of the
 * process list. A command too long for one interactive line falls
 * back to argv, where other processes of the same user can see it for the
 * life of the subprocess.
 */
async function addGenericPassword(
  service: string,
  account: string,
  blob: string,
): Promise<void> {
  const hex = Buffer.from(blob, "utf-8").toString("hex")
  const line = `add-generic-password -s ${interactiveArg(service)} -a ${interactiveArg(account)} -U -X ${hex}\n`
  if (
    Buffer.byteLength(line) <= SECURITY_INTERACTIVE_LINE_MAX &&
    !/[\r\n]/.test(account)
  ) {
    await security(["-i"], {
      timeout: SECURITY_WRITE_PATH_TIMEOUT_MS,
      input: line,
    })
    return
  }
  log("keychain_write_argv", { service, bytes: Buffer.byteLength(line) })
  await security(
    ["add-generic-password", "-s", service, "-a", account, "-U", "-X", hex],
    { timeout: SECURITY_WRITE_PATH_TIMEOUT_MS },
  )
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
 * `failed` is a decision about the stored blob or the item, which another
 * attempt would repeat. `unavailable` means the store could not be reached,
 * even after a second attempt.
 */
export type WriteBackResult = "written" | "conflict" | "failed" | "unavailable"

/** A write the store refused for a reason another attempt cannot change. */
class WriteRefusedError extends Error {}

interface CredentialStore {
  /** Log context for every event this store emits. */
  fields: Record<string, unknown>
  /** The stored blob, or null when nothing is stored. */
  read(): Promise<string | null>
  /**
   * Do whatever a write needs that can be slow, and return the write itself,
   * so that only the write sits between the guard read and the store.
   */
  prepareWrite(): Promise<(blob: string) => Promise<void>>
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
    prepareWrite: async () => async (blob) => {
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
          // readers but says nothing about durability. Without this, a crash
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

function keychainStore(source: string, readTimeoutMs: number): CredentialStore {
  return {
    fields: { source },
    read: () => readKeychainService(source, readTimeoutMs),
    async prepareWrite() {
      // `add-generic-password -U` keys on service plus account. Guessing the
      // account would create a second item instead of updating this one.
      const accountName = await getKeychainAccountName(source)
      if (accountName === null) {
        throw new WriteRefusedError(
          `Keychain item "${source}" is missing or has no account name`,
        )
      }
      return (blob) => addGenericPassword(source, accountName, blob)
    },
  }
}

/**
 * Why a stored blob must not be overwritten, or null when it may be. Two
 * opposite causes share this refusal. Either another account legitimately
 * holds the slot, which needs no action, or the blob cannot be read at all,
 * which means corruption and needs a human. Both return the same result kind
 * but log different events.
 */
function refuseWrite(
  stored: ClaudeCredentials | null,
  fields: Record<string, unknown>,
): WriteBackResult {
  log(
    stored ? "writeback_skipped_stale" : "writeback_skipped_unparseable",
    stored
      ? { ...fields, stored: tokenFingerprint(stored.accessToken) }
      : fields,
  )
  return stored ? "conflict" : "failed"
}

/**
 * Why the stored blob must not be refreshed in place, or null when it still
 * carries the access token we expect.
 *
 * Guards write-back against an external switch landing between the read that
 * produced the token being refreshed and the read just before the write. An
 * unparseable blob is refused, because a write into state we cannot identify
 * is what this guard exists to prevent.
 *
 * This guard is stricter than the write it guards. It validates through
 * parseCredentials (field types, mcpOAuth-only rejection), while
 * updateCredentialBlob rewrites any JSON object. So a blob the
 * write path would happily update can still be refused here. That gap is
 * intentional. Reaching this guard means an earlier parseCredentials
 * succeeded, so a blob that no longer parses changed shape after we read it
 * (a truncated non-atomic external write, or a hand edit), and declining to
 * write over it is correct. Anyone tightening parseCredentials should know it
 * narrows write-back too, not just reads.
 */
function staleBlobResult(
  raw: string,
  expectedAccessToken: string,
  fields: Record<string, unknown>,
): WriteBackResult | null {
  const stored = parseCredentials(raw)
  if (stored?.accessToken === expectedAccessToken) return null
  return refuseWrite(stored, {
    ...fields,
    expected: tokenFingerprint(expectedAccessToken),
  })
}

/**
 * Guarded write of refreshed tokens into the source they came from. The blob
 * is read just before the write and the write is declined when it changed,
 * which preserves unrelated concurrent edits and source rotations that land
 * before that read.
 *
 * This is not atomic. The read and the write are separate operations, and the
 * Claude CLI does not take this plugin's refresh lock, so a rotation it makes
 * in between is overwritten. Anything slow, such as the Keychain account
 * lookup, runs before the read to keep that window short. The refresh lock
 * serializes the plugin's own refreshes, but it is best-effort and can
 * degrade, so they can race here too, though rarely.
 *
 * An unreachable store gets a second attempt. It reuses the guard token:
 * re-reading it would compare the source against itself and turn the retry
 * into an unguarded write over a credential rotated in the gap. A real
 * rotation returns "conflict" instead.
 */
export async function writeBackCredentials(
  source: string,
  creds: ClaudeCredentials,
  configDir: string | undefined,
  expectedPriorAccessToken: string,
): Promise<WriteBackResult> {
  const store = storeFor(source, configDir, SECURITY_WRITE_PATH_TIMEOUT_MS)
  if (!store) return "failed"
  const first = await attemptWriteBack(store, creds, expectedPriorAccessToken)
  if (first !== "unavailable") return first
  return attemptWriteBack(store, creds, expectedPriorAccessToken)
}

async function attemptWriteBack(
  store: CredentialStore,
  creds: ClaudeCredentials,
  expectedPriorAccessToken: string,
): Promise<WriteBackResult> {
  try {
    const write = await store.prepareWrite()
    const raw = await store.read()
    if (raw === null) return "failed"
    const stale = staleBlobResult(raw, expectedPriorAccessToken, store.fields)
    if (stale) return stale
    const updated = updateCredentialBlob(raw, creds)
    if (!updated) return "failed"

    await write(updated)
    // A store can accept a write and keep something else; `security` once
    // stored an empty password and exited 0. Success is what reads back.
    if ((await store.read()) !== updated) {
      throw new Error("the written credentials did not read back")
    }
    log("writeback_success", store.fields)
    return "written"
  } catch (error) {
    if (error instanceof WriteRefusedError) {
      log("writeback_refused", { ...store.fields, error: error.message })
      return "failed"
    }
    log("writeback_failed", { ...store.fields, error: errorMessage(error) })
    return "unavailable"
  }
}

/**
 * The store `source` names, or null when it names nothing this plugin may
 * touch. `readTimeoutMs` bounds each Keychain read: reads on the write path
 * get the long budget, because timing out there reports a write that landed
 * as unsaved.
 */
function storeFor(
  source: string,
  configDir: string | undefined,
  readTimeoutMs: number,
): CredentialStore | null {
  if (source === "file") return fileStore(configDir)
  if (process.platform !== "darwin") return null
  if (!isKnownCredentialSource(source)) {
    // `source` round-trips through OpenCode's credential store, so it is not
    // trusted to still name a Claude Code item by the time it comes back.
    log("store_rejected_source", { source })
    return null
  }
  return keychainStore(source, readTimeoutMs)
}

/** The credentials `source` holds now, or null when it holds none. */
export async function readSourceCredentials(
  source: string,
  configDir?: string,
): Promise<ClaudeCredentials | null> {
  if (source === "file") return readCredentialsFile(configDir)
  const raw = await storeFor(
    source,
    configDir,
    SECURITY_READ_TIMEOUT_MS,
  )?.read()
  return raw ? parseCredentials(raw) : null
}
