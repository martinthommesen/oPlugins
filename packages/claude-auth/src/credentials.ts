import type { Credential } from "@opencode-ai/plugin"
import { log } from "./logger.ts"
import {
  readAllClaudeAccounts,
  refreshAccount,
  credentialSourceID,
  tokenFingerprint,
  writeBackCredentials,
  type ClaudeAccount,
  type ClaudeCredentials,
  type WriteBackResult,
} from "./keychain.ts"
import {
  classifyRefreshFailure,
  clearRefreshOutcome,
  getRefreshCooldownUntil,
  getRefreshFailureKind,
  isRefreshCooldownActive,
  noteRefreshTerminal,
  noteRefreshTransient,
} from "./refresh-backoff.ts"
import { acquireRefreshLock, type RefreshLock } from "./refresh-lock.ts"

export const INTEGRATION_ID = "anthropic"
export const METHOD_ID = "claude-code"
export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const OAUTH_SCOPE = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
].join(" ")

const OAUTH_TIMEOUT_MS = 30_000
const LOCK_ADOPT_WAIT_MS = 5_000
const LOCK_ADOPT_POLL_MS = 250

export interface ClaudeCredentialMetadata extends Record<string, unknown> {
  source: string
  configDir?: string
  accountLabel: string
  sourceTokenHash: string
}

export interface AccountAnswer {
  account?: string | number | boolean | readonly string[]
  [key: string]: string | number | boolean | readonly string[] | undefined
}

export interface OAuthMethodForm {
  key: string
  type: "string"
  title: string
  required: true
  options: Array<{ value: string; label: string }>
}

export type RefreshOutcome =
  | { kind: "ok"; credentials: ClaudeCredentials }
  | {
      kind: "transient"
      status: number
      oauthError?: string
      retryAfterMs?: number
    }
  | { kind: "terminal"; status: number; oauthError?: string }

export type CredentialRefreshKind =
  | "unchanged"
  | "adopted"
  | "refreshed"
  | "transient"

export interface CredentialRefreshResult {
  credential: Credential.OAuth
  kind: CredentialRefreshKind
}

export interface CredentialDependencies {
  readAccounts: () => ClaudeAccount[]
  readSource: (source: string, configDir?: string) => ClaudeCredentials | null
  writeSource: (
    source: string,
    credentials: ClaudeCredentials,
    configDir: string | undefined,
    expectedAccessToken: string,
  ) => WriteBackResult
  fetch: typeof fetch
  acquireLock: (source: string) => RefreshLock | null
  now: () => number
  sleep: (ms: number) => Promise<void>
  lockWaitMs: number
  lockPollMs: number
  oauthTimeoutMs: number
}

const inFlightRefreshes = new Map<string, Promise<CredentialRefreshResult>>()

function refreshSourceKey(metadata: ClaudeCredentialMetadata): string {
  return credentialSourceID(metadata.source, metadata.configDir)
}

function refreshCredentialKey(
  credential: Credential.OAuth,
  metadata: ClaudeCredentialMetadata,
): string {
  return [
    refreshSourceKey(metadata),
    metadata.sourceTokenHash,
    tokenFingerprint(credential.access),
  ].join(":")
}

function clearCredentialRefreshOutcome(
  credential: Credential.OAuth,
  metadata: ClaudeCredentialMetadata,
): void {
  clearRefreshOutcome(refreshCredentialKey(credential, metadata))
  clearRefreshOutcome(refreshSourceKey(metadata))
}

function adaptJoinedResult(
  result: CredentialRefreshResult,
  credential: Credential.OAuth,
  metadata: ClaudeCredentialMetadata,
): CredentialRefreshResult {
  if (result.kind === "transient" || result.kind === "unchanged") {
    return { credential, kind: result.kind }
  }
  const resultMetadata = readMetadata(result.credential)
  return {
    kind: result.kind,
    credential: {
      ...result.credential,
      metadata: {
        ...metadata,
        sourceTokenHash:
          resultMetadata?.sourceTokenHash ?? metadata.sourceTokenHash,
      },
    },
  }
}

function dependencies(
  overrides: Partial<CredentialDependencies> = {},
): CredentialDependencies {
  return {
    readAccounts: readAllClaudeAccounts,
    readSource: refreshAccount,
    writeSource: writeBackCredentials,
    fetch: globalThis.fetch,
    acquireLock: acquireRefreshLock,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    lockWaitMs: LOCK_ADOPT_WAIT_MS,
    lockPollMs: LOCK_ADOPT_POLL_MS,
    oauthTimeoutMs: OAUTH_TIMEOUT_MS,
    ...overrides,
  }
}

export function buildAccountForm(
  accounts: ClaudeAccount[],
): [OAuthMethodForm] | undefined {
  if (accounts.length <= 1) return undefined
  return [
    {
      key: "account",
      type: "string",
      title: "Claude Code account",
      required: true,
      options: accounts.map((account) => ({
        value: account.source,
        label: account.label,
      })),
    },
  ]
}

export function createOAuthCredential(
  account: ClaudeAccount,
): Credential.OAuth {
  const metadata: ClaudeCredentialMetadata = {
    source: account.source,
    accountLabel: account.label,
    sourceTokenHash: tokenFingerprint(account.credentials.accessToken),
  }
  if (account.configDir) metadata.configDir = account.configDir
  const credential = fromSourceCredentials(account.credentials, metadata)
  clearCredentialRefreshOutcome(credential, metadata)
  return credential
}

export function authorizeAccount(
  startupAccounts: ClaudeAccount[],
  answer: AccountAnswer,
  overrides: Partial<CredentialDependencies> = {},
): Credential.OAuth {
  const deps = dependencies(overrides)
  if (startupAccounts.length > 1 && typeof answer.account !== "string") {
    throw new Error("Select a registered Claude Code account")
  }
  const requested =
    startupAccounts.length > 1
      ? (answer.account as string)
      : startupAccounts[0]?.source

  if (!requested) {
    throw new Error(
      "No Claude Code credentials were found. Run `claude` to authenticate, restart the OpenCode service, and try /connect again.",
    )
  }

  const selected = startupAccounts.find(
    (account) => account.source === requested,
  )
  if (!selected) {
    throw new Error("The selected Claude Code account was not registered")
  }

  const account = deps
    .readAccounts()
    .find(
      (candidate) =>
        candidate.source === selected.source &&
        candidate.configDir === selected.configDir,
    )
  if (!account) {
    throw new Error(
      "The selected Claude Code account is no longer available. Restart the OpenCode service to refresh the account list.",
    )
  }
  return createOAuthCredential(account)
}

export function credentialLabel(
  credential: Credential.OAuth,
): string | undefined {
  return readMetadata(credential)?.accountLabel
}

export function isClaudeCodeCredential(
  credential: Credential.Value | undefined,
): credential is Credential.OAuth {
  return (
    credential?.type === "oauth" &&
    credential.methodID === METHOD_ID &&
    readMetadata(credential) !== null
  )
}

export function readMetadata(
  credential: Credential.OAuth,
): ClaudeCredentialMetadata | null {
  const metadata = credential.metadata
  if (!metadata || typeof metadata !== "object") return null
  const { source, configDir, accountLabel, sourceTokenHash } = metadata
  if (
    typeof source !== "string" ||
    typeof accountLabel !== "string" ||
    typeof sourceTokenHash !== "string" ||
    (configDir !== undefined && typeof configDir !== "string")
  ) {
    return null
  }
  return { source, configDir, accountLabel, sourceTokenHash }
}

function fromSourceCredentials(
  credentials: ClaudeCredentials,
  metadata: ClaudeCredentialMetadata,
): Credential.OAuth {
  return {
    type: "oauth",
    methodID: METHOD_ID as Credential.OAuth["methodID"],
    access: credentials.accessToken,
    refresh: credentials.refreshToken,
    expires: Math.trunc(credentials.expiresAt),
    metadata,
  }
}

function fromOAuthCredential(credential: Credential.OAuth): ClaudeCredentials {
  return {
    accessToken: credential.access,
    refreshToken: credential.refresh,
    expiresAt: credential.expires,
  }
}

function usable(credentials: ClaudeCredentials, now: number): boolean {
  return (
    credentials.accessToken.trim().length > 0 && credentials.expiresAt > now
  )
}

function safeReadSource(
  metadata: ClaudeCredentialMetadata,
  deps: CredentialDependencies,
): ClaudeCredentials | null {
  try {
    return deps.readSource(metadata.source, metadata.configDir)
  } catch (error) {
    log("source_read_failed", {
      source: metadata.source,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export function adoptExternalCredential(
  credential: Credential.OAuth,
  overrides: Partial<CredentialDependencies> = {},
): CredentialRefreshResult {
  const deps = dependencies(overrides)
  const metadata = readMetadata(credential)
  if (!metadata) return { credential, kind: "unchanged" }
  const stored = safeReadSource(metadata, deps)
  return adoptStoredCredential(credential, metadata, stored, deps)
}

function adoptStoredCredential(
  credential: Credential.OAuth,
  metadata: ClaudeCredentialMetadata,
  stored: ClaudeCredentials | null,
  deps: CredentialDependencies,
): CredentialRefreshResult {
  if (
    !stored ||
    !usable(stored, deps.now()) ||
    tokenFingerprint(stored.accessToken) === metadata.sourceTokenHash
  ) {
    return { credential, kind: "unchanged" }
  }

  clearCredentialRefreshOutcome(credential, metadata)
  log("credential_adopted", { source: metadata.source })
  return {
    credential: fromSourceCredentials(stored, {
      ...metadata,
      sourceTokenHash: tokenFingerprint(stored.accessToken),
    }),
    kind: "adopted",
  }
}

function parseRetryAfterMs(
  value: string | null,
  now: number,
): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) && date > now ? date - now : undefined
}

export function extractOAuthError(raw: string): {
  oauthError?: string
  oauthErrorDescription?: string
} {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const data = value as {
    error?: unknown
    error_description?: unknown
  }
  const result: {
    oauthError?: string
    oauthErrorDescription?: string
  } = {}
  if (typeof data.error === "string") {
    result.oauthError = data.error.slice(0, 200)
  } else if (data.error && typeof data.error === "object") {
    const nested = data.error as { type?: unknown; message?: unknown }
    if (typeof nested.type === "string") {
      result.oauthError = nested.type.slice(0, 200)
    }
    if (typeof nested.message === "string") {
      result.oauthErrorDescription = nested.message.slice(0, 500)
    }
  }
  if (typeof data.error_description === "string") {
    result.oauthErrorDescription = data.error_description.slice(0, 500)
  }
  return result
}

export function parseOAuthResponse(
  raw: string,
  currentRefreshToken: string,
  now: number = Date.now(),
): ClaudeCredentials | null {
  let data: {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
    expires_at?: unknown
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    data = value as typeof data
  } catch {
    return null
  }
  if (
    typeof data.access_token !== "string" ||
    data.access_token.trim().length === 0
  ) {
    return null
  }
  const absoluteExpiry =
    typeof data.expires_at === "number" &&
    Number.isFinite(data.expires_at) &&
    data.expires_at > now
      ? data.expires_at
      : null
  const relativeExpiry =
    typeof data.expires_in === "number" &&
    Number.isFinite(data.expires_in) &&
    data.expires_in > 0
      ? now + data.expires_in * 1000
      : null
  const expiresAt = absoluteExpiry ?? relativeExpiry
  if (expiresAt === null || !Number.isFinite(expiresAt)) return null
  if (
    data.refresh_token !== undefined &&
    (typeof data.refresh_token !== "string" ||
      data.refresh_token.trim().length === 0)
  ) {
    return null
  }
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" && data.refresh_token
        ? data.refresh_token
        : currentRefreshToken,
    expiresAt: Math.trunc(expiresAt),
  }
}

export async function exchangeRefreshToken(
  refreshToken: string,
  overrides: Partial<CredentialDependencies> = {},
): Promise<RefreshOutcome> {
  const deps = dependencies(overrides)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.oauthTimeoutMs)
  try {
    const response = await deps.fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
        scope: OAUTH_SCOPE,
      }),
      signal: controller.signal,
    })
    const raw = await response.text()
    if (!response.ok) {
      const detail = extractOAuthError(raw)
      const kind = classifyRefreshFailure(response.status, detail.oauthError)
      return kind === "terminal"
        ? { kind, status: response.status, oauthError: detail.oauthError }
        : {
            kind,
            status: response.status,
            oauthError: detail.oauthError,
            retryAfterMs: parseRetryAfterMs(
              response.headers.get("retry-after"),
              deps.now(),
            ),
          }
    }
    const credentials = parseOAuthResponse(raw, refreshToken, deps.now())
    return credentials
      ? { kind: "ok", credentials }
      : { kind: "transient", status: response.status }
  } catch (error) {
    log("refresh_request_failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return { kind: "transient", status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

export class ClaudeAuthTerminalError extends Error {
  constructor() {
    super(
      "Claude Code credentials could not be renewed. Run `claude` to authenticate the selected account, then try again.",
    )
    this.name = "ClaudeAuthTerminalError"
  }
}

async function waitForExternalCredential(
  credential: Credential.OAuth,
  deps: CredentialDependencies,
): Promise<CredentialRefreshResult> {
  const deadline = deps.now() + deps.lockWaitMs
  let adopted = adoptExternalCredential(credential, deps)
  while (adopted.kind !== "adopted" && deps.now() < deadline) {
    await deps.sleep(deps.lockPollMs)
    adopted = adoptExternalCredential(credential, deps)
  }
  return adopted.kind === "adopted"
    ? adopted
    : { credential, kind: "transient" }
}

async function performCredentialRefresh(
  credential: Credential.OAuth,
  deps: CredentialDependencies,
): Promise<CredentialRefreshResult> {
  const metadata = readMetadata(credential)
  if (!metadata) return { credential, kind: "unchanged" }
  const sourceKey = refreshSourceKey(metadata)
  const credentialKey = refreshCredentialKey(credential, metadata)

  const adopted = adoptExternalCredential(credential, deps)
  if (adopted.kind === "adopted") return adopted
  if (getRefreshFailureKind(credentialKey) === "terminal") {
    throw new ClaudeAuthTerminalError()
  }
  if (isRefreshCooldownActive(sourceKey, deps.now())) {
    return { credential, kind: "transient" }
  }

  const lock = deps.acquireLock(sourceKey)
  if (!lock) return waitForExternalCredential(credential, deps)

  try {
    const priorSource = safeReadSource(metadata, deps)
    const afterLock = adoptStoredCredential(
      credential,
      metadata,
      priorSource,
      deps,
    )
    if (afterLock.kind === "adopted") return afterLock
    if (getRefreshFailureKind(credentialKey) === "terminal") {
      throw new ClaudeAuthTerminalError()
    }
    if (isRefreshCooldownActive(sourceKey, deps.now())) {
      return { credential, kind: "transient" }
    }

    const sourceChanged =
      priorSource !== null &&
      tokenFingerprint(priorSource.accessToken) !== metadata.sourceTokenHash
    const refreshToken = sourceChanged
      ? priorSource.refreshToken
      : credential.refresh
    if (!lock.extend(deps.oauthTimeoutMs + 15_000)) {
      return waitForExternalCredential(credential, deps)
    }
    const outcome = await exchangeRefreshToken(refreshToken, deps)
    if (outcome.kind === "transient") {
      const cooldownMs = noteRefreshTransient(sourceKey, {
        retryAfterMs: outcome.retryAfterMs,
      })
      lock.defer(cooldownMs)
      log("refresh_transient", {
        source: metadata.source,
        status: outcome.status,
        oauthError: outcome.oauthError,
        cooldownMs,
      })
      return { credential, kind: "transient" }
    }
    if (outcome.kind === "terminal") {
      const winner = adoptExternalCredential(credential, deps)
      if (winner.kind === "adopted") return winner
      noteRefreshTerminal(credentialKey)
      log("refresh_terminal", {
        source: metadata.source,
        status: outcome.status,
        oauthError: outcome.oauthError,
      })
      throw new ClaudeAuthTerminalError()
    }

    clearCredentialRefreshOutcome(credential, metadata)
    const expectedAccessToken =
      priorSource?.accessToken ?? fromOAuthCredential(credential).accessToken
    const writeResult = deps.writeSource(
      metadata.source,
      outcome.credentials,
      metadata.configDir,
      expectedAccessToken,
    )
    if (writeResult === "conflict") {
      const winner = adoptExternalCredential(credential, deps)
      if (winner.kind === "adopted") return winner
    }

    const sourceTokenHash =
      writeResult === "written"
        ? tokenFingerprint(outcome.credentials.accessToken)
        : priorSource
          ? tokenFingerprint(priorSource.accessToken)
          : metadata.sourceTokenHash
    log("refresh_success", { source: metadata.source, writeResult })
    return {
      credential: fromSourceCredentials(outcome.credentials, {
        ...metadata,
        sourceTokenHash,
      }),
      kind: "refreshed",
    }
  } finally {
    lock.release()
  }
}

export async function refreshClaudeCredentialDetailed(
  credential: Credential.OAuth,
  overrides: Partial<CredentialDependencies> = {},
): Promise<CredentialRefreshResult> {
  const metadata = readMetadata(credential)
  if (!metadata) return { credential, kind: "unchanged" }
  const sourceKey = refreshSourceKey(metadata)

  const existing = inFlightRefreshes.get(sourceKey)
  if (existing) {
    return adaptJoinedResult(await existing, credential, metadata)
  }

  const deps = dependencies(overrides)
  const pending = performCredentialRefresh(credential, deps)
  inFlightRefreshes.set(sourceKey, pending)
  try {
    return await pending
  } finally {
    if (inFlightRefreshes.get(sourceKey) === pending) {
      inFlightRefreshes.delete(sourceKey)
    }
  }
}

export async function refreshClaudeCredential(
  credential: Credential.OAuth,
  overrides: Partial<CredentialDependencies> = {},
): Promise<Credential.OAuth> {
  return (await refreshClaudeCredentialDetailed(credential, overrides))
    .credential
}

export function refreshRetryAfterSeconds(
  credential: Credential.OAuth,
  now: number = Date.now(),
): number {
  const metadata = readMetadata(credential)
  const until = metadata
    ? getRefreshCooldownUntil(refreshSourceKey(metadata))
    : null
  return Math.max(
    1,
    Math.min(60, Math.ceil(((until ?? now + 5_000) - now) / 1000)),
  )
}

export function resetCredentialStateForTests(): void {
  inFlightRefreshes.clear()
}
