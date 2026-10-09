import type { Credential } from "@opencode/plugin"
import { setTimeout as sleep } from "node:timers/promises"
import { isRecord, parseJsonRecord } from "./json.ts"
import { errorMessage, log, warn } from "./logger.ts"
import {
  readSourceCredentials,
  credentialSourceID,
  isKnownCredentialSource,
  tokenFingerprint,
  writeBackCredentials,
  type ClaudeAccount,
  type ClaudeCredentials,
  type WriteBackResult,
} from "./keychain.ts"
import {
  classifyRefreshFailure,
  clearRefreshOutcome,
  cooldownRemainingMs,
  getRefreshFailureKind,
  noteRefreshTerminal,
  MAX_CONSECUTIVE_TRANSIENT,
  noteRefreshTransient,
  transientFailureCount,
} from "./refresh-backoff.ts"
import { acquireRefreshLock, type LockAttempt } from "./refresh-lock.ts"

export const INTEGRATION_ID = "anthropic"
/** Branded by the host SDK; the one cast lives here instead of at each use. */
export const METHOD_ID = "claude-code" as Credential.OAuth["methodID"]
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
/** Suggested wait when another process's refresh did not land in time. */
const REFRESH_IN_PROGRESS_RETRY_MS = 5_000

interface ClaudeCredentialMetadata extends Record<string, unknown> {
  source: string
  configDir?: string
  accountLabel: string
  sourceTokenHash: string
}

interface AccountAnswer {
  account?: string | number | boolean | readonly string[]
  [key: string]: string | number | boolean | readonly string[] | undefined
}

interface OAuthMethodForm {
  key: string
  type: "string"
  title: string
  required: true
  options: Array<{ value: string; label: string }>
}

type RefreshOutcome =
  | { kind: "ok"; credentials: ClaudeCredentials }
  | {
      kind: "transient"
      status: number
      oauthError?: string
      retryAfterMs?: number
    }
  | { kind: "terminal"; status: number; oauthError?: string }

/**
 * `transient` keeps the credential it was given and says how long to wait
 * before asking again.
 */
export type CredentialRefreshResult =
  | {
      credential: Credential.OAuth
      kind: "unchanged" | "adopted" | "refreshed"
    }
  | { credential: Credential.OAuth; kind: "transient"; retryAfterMs: number }

export interface CredentialDependencies {
  readSource: (
    source: string,
    configDir?: string,
  ) => Promise<ClaudeCredentials | null>
  writeSource: (
    source: string,
    credentials: ClaudeCredentials,
    configDir: string | undefined,
    expectedAccessToken: string,
  ) => Promise<WriteBackResult>
  fetch: typeof fetch
  acquireLock: (source: string) => LockAttempt
  now: () => number
  sleep: (ms: number) => Promise<void>
  lockWaitMs: number
}

interface InFlightRefresh {
  credentialKey: string
  result: Promise<CredentialRefreshResult>
}

const inFlightRefreshes = new Map<string, InFlightRefresh>()

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
  if (result.kind === "transient") return { ...result, credential }
  if (result.kind === "unchanged") return { credential, kind: "unchanged" }
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
    readSource: readSourceCredentials,
    writeSource: writeBackCredentials,
    fetch: globalThis.fetch,
    acquireLock: acquireRefreshLock,
    now: Date.now,
    sleep,
    lockWaitMs: LOCK_ADOPT_WAIT_MS,
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

export async function authorizeAccount(
  startupAccounts: ClaudeAccount[],
  answer: AccountAnswer,
  overrides: Partial<CredentialDependencies> = {},
): Promise<Credential.OAuth> {
  const deps = dependencies(overrides)
  const answered = answer.account
  if (startupAccounts.length > 1 && typeof answered !== "string") {
    throw new Error("Select a registered Claude Code account")
  }
  const requested =
    typeof answered === "string" && startupAccounts.length > 1
      ? answered
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

  const credentials = await deps.readSource(selected.source, selected.configDir)
  if (!credentials) {
    throw new Error(
      "The selected Claude Code account is no longer available. Restart the OpenCode service to refresh the account list.",
    )
  }
  return createOAuthCredential({ ...selected, credentials })
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
    // Validated here, at the one gate every consumer passes through, rather
    // than at each place that hands `source` to a subprocess.
    !isKnownCredentialSource(source) ||
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
    methodID: METHOD_ID,
    access: credentials.accessToken,
    refresh: credentials.refreshToken,
    expires: Math.trunc(credentials.expiresAt),
    metadata,
  }
}

function usable(credentials: ClaudeCredentials, now: number): boolean {
  return (
    credentials.accessToken.trim().length > 0 && credentials.expiresAt > now
  )
}

async function safeReadSource(
  metadata: ClaudeCredentialMetadata,
  deps: CredentialDependencies,
): Promise<ClaudeCredentials | null> {
  try {
    return await deps.readSource(metadata.source, metadata.configDir)
  } catch (error) {
    log("source_read_failed", {
      source: metadata.source,
      error: errorMessage(error),
    })
    return null
  }
}

export async function adoptExternalCredential(
  credential: Credential.OAuth,
  overrides: Partial<CredentialDependencies> = {},
): Promise<CredentialRefreshResult> {
  const deps = dependencies(overrides)
  const metadata = readMetadata(credential)
  if (!metadata) return { credential, kind: "unchanged" }
  const stored = await safeReadSource(metadata, deps)
  return adoptStoredCredential(credential, metadata, stored, deps)
}

function adoptStoredCredential(
  credential: Credential.OAuth,
  metadata: ClaudeCredentialMetadata,
  stored: ClaudeCredentials | null,
  deps: CredentialDependencies,
): CredentialRefreshResult {
  if (!stored || !usable(stored, deps.now())) {
    return { credential, kind: "unchanged" }
  }
  const sourceTokenHash = tokenFingerprint(stored.accessToken)
  if (sourceTokenHash === metadata.sourceTokenHash) {
    return { credential, kind: "unchanged" }
  }

  clearCredentialRefreshOutcome(credential, metadata)
  log("credential_adopted", { source: metadata.source })
  return {
    credential: fromSourceCredentials(stored, { ...metadata, sourceTokenHash }),
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

/** The OAuth error code in a token-endpoint error body, if it has one. */
function extractOAuthError(raw: string): string | undefined {
  const data = parseJsonRecord(raw)
  const code = isRecord(data?.error) ? data.error.type : data?.error
  return typeof code === "string" ? code.slice(0, 200) : undefined
}

export function parseOAuthResponse(
  raw: string,
  currentRefreshToken: string,
  now: number = Date.now(),
): ClaudeCredentials | null {
  const data = parseJsonRecord(raw)
  if (!data) return null
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
      typeof data.refresh_token === "string"
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
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    })
    const raw = await response.text()
    if (!response.ok) {
      const oauthError = extractOAuthError(raw)
      const kind = classifyRefreshFailure(oauthError)
      return kind === "terminal"
        ? { kind, status: response.status, oauthError }
        : {
            kind,
            status: response.status,
            oauthError,
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
    // Network failures, timeouts, and aborts all reach this catch. The logged
    // error name tells them apart, and tells them from a bug.
    log("refresh_request_failed", {
      errorName: error instanceof Error ? error.name : typeof error,
      error: errorMessage(error),
    })
    return { kind: "transient", status: 0 }
  }
}

function describeTransient(status: number, oauthError?: string): string {
  if (status === 0) return "network error"
  return oauthError ? `HTTP ${status}: ${oauthError}` : `HTTP ${status}`
}

export class ClaudeAuthTerminalError extends Error {
  constructor() {
    super(
      "Claude Code credentials could not be renewed. Run `claude` to authenticate the selected account, then try again.",
    )
    this.name = "ClaudeAuthTerminalError"
  }
}

/**
 * Refreshing kept failing for reasons that say nothing against the refresh
 * token itself: the network, the token endpoint, or the credential store.
 * Unlike {@link ClaudeAuthTerminalError} nothing is latched; the next attempt
 * after the cooldown goes out as usual, so recovery needs no restart.
 */
export class ClaudeAuthRefreshExhaustedError extends Error {
  constructor(failures: number, cause: string) {
    super(
      `Claude Code token refresh has failed ${failures} times in a row (${cause}). Check your network connection; the plugin keeps retrying.`,
    )
    this.name = "ClaudeAuthRefreshExhaustedError"
  }
}

async function waitForExternalCredential(
  credential: Credential.OAuth,
  deps: CredentialDependencies,
): Promise<CredentialRefreshResult> {
  const deadline = deps.now() + deps.lockWaitMs
  let adopted = await adoptExternalCredential(credential, deps)
  while (adopted.kind !== "adopted" && deps.now() < deadline) {
    await deps.sleep(LOCK_ADOPT_POLL_MS)
    adopted = await adoptExternalCredential(credential, deps)
  }
  return adopted.kind === "adopted"
    ? adopted
    : {
        credential,
        kind: "transient",
        retryAfterMs: REFRESH_IN_PROGRESS_RETRY_MS,
      }
}

/**
 * Why a refresh must not proceed for this credential right now: a terminal
 * failure already recorded for exactly this token, or an active cooldown for
 * its source. Null when the refresh may go ahead.
 */
function refreshBlocked(
  credential: Credential.OAuth,
  credentialKey: string,
  sourceKey: string,
  deps: CredentialDependencies,
): CredentialRefreshResult | null {
  if (getRefreshFailureKind(credentialKey) === "terminal") {
    throw new ClaudeAuthTerminalError()
  }
  const retryAfterMs = cooldownRemainingMs(sourceKey, deps.now())
  return retryAfterMs > 0
    ? { credential, kind: "transient", retryAfterMs }
    : null
}

async function performCredentialRefresh(
  credential: Credential.OAuth,
  deps: CredentialDependencies,
): Promise<CredentialRefreshResult> {
  const metadata = readMetadata(credential)
  if (!metadata) return { credential, kind: "unchanged" }
  const sourceKey = refreshSourceKey(metadata)
  const credentialKey = refreshCredentialKey(credential, metadata)

  const adopted = await adoptExternalCredential(credential, deps)
  if (adopted.kind === "adopted") return adopted
  const blocked = refreshBlocked(credential, credentialKey, sourceKey, deps)
  if (blocked) return blocked

  const attempt = deps.acquireLock(sourceKey)
  if (attempt.kind === "busy")
    return waitForExternalCredential(credential, deps)
  if (attempt.kind === "cooldown") {
    // Another process failed and is backing off, so no credential is coming.
    const retryAfterMs = Math.max(0, attempt.until - deps.now())
    log("refresh_cooldown_elsewhere", { source: metadata.source, retryAfterMs })
    return { credential, kind: "transient", retryAfterMs }
  }
  const { lock } = attempt

  /**
   * Record a transient failure, then either back off quietly or, past the
   * ceiling, tell the user. Nothing is latched: the next attempt after the
   * cooldown goes out as usual.
   */
  const transient = (
    cause: string,
    retryAfterMs?: number,
  ): CredentialRefreshResult => {
    const cooldownMs = noteRefreshTransient(sourceKey, {
      retryAfterMs,
      now: deps.now(),
    })
    lock.defer(cooldownMs)
    const failures = transientFailureCount(sourceKey)
    log("refresh_transient", {
      source: metadata.source,
      cause,
      cooldownMs,
      failures,
    })
    if (failures >= MAX_CONSECUTIVE_TRANSIENT) {
      throw new ClaudeAuthRefreshExhaustedError(failures, cause)
    }
    return { credential, kind: "transient", retryAfterMs: cooldownMs }
  }

  try {
    let priorSource: ClaudeCredentials | null
    try {
      priorSource = await deps.readSource(metadata.source, metadata.configDir)
    } catch (error) {
      // Refreshing blind would rotate the token Claude Code holds with no way
      // to write the replacement back. That would sign the CLI out.
      return transient(
        `Claude Code credentials could not be read: ${errorMessage(error)}`,
      )
    }
    const afterLock = adoptStoredCredential(
      credential,
      metadata,
      priorSource,
      deps,
    )
    if (afterLock.kind === "adopted") return afterLock
    const blockedAfterLock = refreshBlocked(
      credential,
      credentialKey,
      sourceKey,
      deps,
    )
    if (blockedAfterLock) return blockedAfterLock

    const priorSourceHash = priorSource
      ? tokenFingerprint(priorSource.accessToken)
      : null
    const refreshToken =
      priorSource && priorSourceHash !== metadata.sourceTokenHash
        ? priorSource.refreshToken
        : credential.refresh
    if (!lock.extend(OAUTH_TIMEOUT_MS + 15_000)) {
      return waitForExternalCredential(credential, deps)
    }
    const outcome = await exchangeRefreshToken(refreshToken, deps)
    if (outcome.kind === "transient") {
      return transient(
        describeTransient(outcome.status, outcome.oauthError),
        outcome.retryAfterMs,
      )
    }
    if (outcome.kind === "terminal") {
      const winner = await adoptExternalCredential(credential, deps)
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
    const expectedAccessToken = priorSource?.accessToken ?? credential.access
    const writeResult = await deps.writeSource(
      metadata.source,
      outcome.credentials,
      metadata.configDir,
      expectedAccessToken,
    )

    let sourceTokenHash = priorSourceHash ?? metadata.sourceTokenHash
    switch (writeResult) {
      case "written":
        sourceTokenHash = tokenFingerprint(outcome.credentials.accessToken)
        break
      case "conflict": {
        const winner = await adoptExternalCredential(credential, deps)
        if (winner.kind === "adopted") return winner
        break
      }
      case "failed":
      case "unavailable":
        warn(
          "refresh_writeback_failed",
          `refreshed Claude Code credentials could not be saved to ${describeSource(metadata)}. OpenCode keeps working, but the \`claude\` CLI will need to sign in again once its current token expires.`,
          { source: metadata.source, reason: writeResult },
        )
        break
      default: {
        const unhandled: never = writeResult
        throw new Error(`unhandled write-back result ${String(unhandled)}`)
      }
    }
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

function describeSource(metadata: ClaudeCredentialMetadata): string {
  return metadata.source === "file"
    ? "the Claude Code credentials file"
    : `the macOS Keychain item "${metadata.source}"`
}

export async function refreshClaudeCredentialDetailed(
  credential: Credential.OAuth,
  overrides: Partial<CredentialDependencies> = {},
): Promise<CredentialRefreshResult> {
  const metadata = readMetadata(credential)
  if (!metadata) return { credential, kind: "unchanged" }
  const sourceKey = refreshSourceKey(metadata)
  const credentialKey = refreshCredentialKey(credential, metadata)

  const existing = inFlightRefreshes.get(sourceKey)
  if (existing) {
    try {
      return adaptJoinedResult(await existing.result, credential, metadata)
    } catch (error) {
      // A terminal outcome is about the leader's refresh token. A joiner
      // holding a newer generation of the same source still has its own.
      if (
        !(error instanceof ClaudeAuthTerminalError) ||
        existing.credentialKey === credentialKey
      ) {
        throw error
      }
    }
  }

  const deps = dependencies(overrides)
  const pending: InFlightRefresh = {
    credentialKey,
    result: performCredentialRefresh(credential, deps),
  }
  inFlightRefreshes.set(sourceKey, pending)
  try {
    return await pending.result
  } finally {
    if (inFlightRefreshes.get(sourceKey) === pending) {
      inFlightRefreshes.delete(sourceKey)
    }
  }
}

export function resetCredentialStateForTests(): void {
  inFlightRefreshes.clear()
}
