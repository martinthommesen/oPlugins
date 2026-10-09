import type { Credential } from "@opencode/plugin"
import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  adoptExternalCredential,
  authorizeAccount,
  buildAccountForm,
  ClaudeAuthRefreshExhaustedError,
  ClaudeAuthTerminalError,
  createOAuthCredential,
  credentialLabel,
  exchangeRefreshToken,
  METHOD_ID,
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
  OAUTH_TOKEN_URL,
  parseOAuthResponse,
  readMetadata,
  refreshClaudeCredentialDetailed,
  resetCredentialStateForTests,
  type CredentialDependencies,
} from "./credentials.ts"
import {
  MAX_CONSECUTIVE_TRANSIENT,
  resetRefreshBackoffState,
} from "./refresh-backoff.ts"
import {
  tokenFingerprint,
  type ClaudeAccount,
  type ClaudeCredentials,
} from "./keychain.ts"
import type { LockAttempt } from "./refresh-lock.ts"
import { captureWarnings, withEnv } from "./test-helpers.ts"

// A default dependency that slips through must not reach the real Keychain.
// Each test file runs in its own process, so this never needs restoring.
withEnv("OPENCODE_CLAUDE_AUTH_SECURITY_BIN", "/nonexistent/security")

// Warnings go to stderr in production; collected here so a test can assert
// them and the suite's output stays clean.
let warnings: string[] = []
let restoreWarnings = (): void => {}

const now = Date.now()

// Real Keychain service names. Credential metadata is validated on the way
// back in, so a fixture using an arbitrary name would not round-trip.
const ACCOUNT_A = "Claude Code-credentials-aaaaaaaa"
const ACCOUNT_B = "Claude Code-credentials-bbbbbbbb"
const ACCOUNT_C = "Claude Code-credentials-cccccccc"

function account(
  source = "Claude Code-credentials",
  accessToken = "old-access",
): ClaudeAccount {
  return {
    label: `Claude Pro: ${source}`,
    source,
    configDir: `/claude/${source}`,
    credentials: {
      accessToken,
      refreshToken: "old-refresh",
      expiresAt: now + 60_000,
      subscriptionType: "pro",
    },
  }
}

function successfulResponse(accessToken = "new-access"): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: "new-refresh",
      expires_in: 3600,
    }),
  )
}

/** The token endpoint rejecting the refresh token for good. */
function invalidGrant(): Response {
  return new Response('{"error":"invalid_grant"}', { status: 400 })
}

/** The token endpoint rate limiting, optionally with a retry-after header. */
function rateLimited(retryAfter?: string): Response {
  return new Response('{"error":"rate_limit_error"}', {
    status: 429,
    ...(retryAfter === undefined
      ? {}
      : { headers: { "retry-after": retryAfter } }),
  })
}

function fakeLock(options: { extend?: boolean } = {}) {
  return (): LockAttempt => ({
    kind: "held",
    lock: {
      extend: () => options.extend ?? true,
      defer() {},
      release() {},
      degraded: false,
    },
  })
}

function credentialDependencies(
  stored: () => ClaudeCredentials | null,
  overrides: Partial<CredentialDependencies> = {},
): Partial<CredentialDependencies> {
  return {
    readSource: async () => stored(),
    writeSource: async () => "written",
    acquireLock: fakeLock(),
    fetch: async () => successfulResponse(),
    now: Date.now,
    lockWaitMs: 0,
    ...overrides,
  }
}

beforeEach(() => {
  resetCredentialStateForTests()
  resetRefreshBackoffState()
  const capture = captureWarnings()
  warnings = capture.lines
  restoreWarnings = capture.restore
})

afterEach(() => restoreWarnings())

/** A `readSource` answering from `accounts`, recording what it was asked. */
function sourceReader(accounts: ClaudeAccount[]) {
  const reads: Array<[string, string | undefined]> = []
  return {
    reads,
    readSource: async (source: string, configDir?: string) => {
      reads.push([source, configDir])
      return (
        accounts.find(
          (candidate) =>
            candidate.source === source && candidate.configDir === configDir,
        )?.credentials ?? null
      )
    },
  }
}

describe("Claude Code OAuth method", () => {
  it("builds a static account form only for multiple accounts", () => {
    assert.equal(buildAccountForm([]), undefined)
    assert.equal(buildAccountForm([account()]), undefined)
    assert.deepEqual(
      buildAccountForm([account(ACCOUNT_A), account(ACCOUNT_B)]),
      [
        {
          key: "account",
          type: "string",
          title: "Claude Code account",
          required: true,
          options: [
            { value: ACCOUNT_A, label: `Claude Pro: ${ACCOUNT_A}` },
            { value: ACCOUNT_B, label: `Claude Pro: ${ACCOUNT_B}` },
          ],
        },
      ],
    )
  })

  it("imports the selected account's current credentials with its startup label", async () => {
    const startup = [account(ACCOUNT_A), account(ACCOUNT_B, "two-access")]
    // The source rotated since startup; the import takes what it holds now.
    const { reads, readSource } = sourceReader([
      account(ACCOUNT_B, "rotated-access"),
    ])
    const credential = await authorizeAccount(
      startup,
      { account: ACCOUNT_B },
      { readSource },
    )
    assert.deepEqual(reads, [[ACCOUNT_B, `/claude/${ACCOUNT_B}`]])
    assert.equal(credential.type, "oauth")
    assert.equal(credential.methodID, METHOD_ID)
    assert.equal(credential.access, "rotated-access")
    assert.equal(credentialLabel(credential), `Claude Pro: ${ACCOUNT_B}`)
    assert.deepEqual(readMetadata(credential), {
      source: ACCOUNT_B,
      configDir: `/claude/${ACCOUNT_B}`,
      accountLabel: `Claude Pro: ${ACCOUNT_B}`,
      sourceTokenHash: tokenFingerprint("rotated-access"),
    })
    assert.equal(
      JSON.stringify(credential.metadata).includes("rotated-access"),
      false,
    )
  })

  it("fails closed when the selected account disappeared", async () => {
    const accounts = [account(ACCOUNT_A), account(ACCOUNT_B)]
    await assert.rejects(
      authorizeAccount(
        accounts,
        { account: ACCOUNT_B },
        sourceReader([accounts[0]]),
      ),
      /no longer available/,
    )
  })

  it("requires an explicit valid answer for a multiple-account form", async () => {
    const accounts = [account(ACCOUNT_A), account(ACCOUNT_B)]
    const { reads, readSource } = sourceReader(accounts)
    await assert.rejects(
      authorizeAccount(accounts, {}, { readSource }),
      /Select a registered/,
    )
    await assert.rejects(
      authorizeAccount(accounts, { account: true }, { readSource }),
      /Select a registered/,
    )
    assert.deepEqual(reads, [])
  })

  it("does not expose accounts added after registration", async () => {
    const startup = [account(ACCOUNT_A)]
    const { reads, readSource } = sourceReader([account(ACCOUNT_C), startup[0]])
    const imported = await authorizeAccount(startup, {}, { readSource })
    assert.equal(readMetadata(imported)?.source, ACCOUNT_A)
    assert.deepEqual(reads, [[ACCOUNT_A, `/claude/${ACCOUNT_A}`]])
  })
})

describe("OAuth exchange", () => {
  it("uses the platform JSON contract exactly once", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const outcome = await exchangeRefreshToken("refresh-token", {
      fetch: async (input, init) => {
        calls.push({ input, init })
        return successfulResponse()
      },
    })
    assert.equal(outcome.kind, "ok")
    assert.equal(calls.length, 1)
    assert.equal(calls[0].input, OAUTH_TOKEN_URL)
    assert.equal(
      new Headers(calls[0].init?.headers).get("content-type"),
      "application/json",
    )
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: "refresh-token",
      scope: OAUTH_SCOPE,
    })
  })

  it("reads retry-after as seconds or as an HTTP date", async () => {
    const at = Date.parse("2026-01-01T00:00:00Z")
    const exchangeAfter = (retryAfter: string) =>
      exchangeRefreshToken("refresh-token", {
        now: () => at,
        fetch: async () => rateLimited(retryAfter),
      })
    const seconds = await exchangeAfter("7")
    const date = await exchangeAfter("Thu, 01 Jan 2026 00:00:30 GMT")
    const garbage = await exchangeAfter("soon")
    assert.equal(seconds.kind === "transient" && seconds.retryAfterMs, 7000)
    assert.equal(date.kind === "transient" && date.retryAfterMs, 30_000)
    assert.equal(
      garbage.kind === "transient" && garbage.retryAfterMs,
      undefined,
    )
  })

  it("parses absolute and relative expiries without losing refresh tokens", () => {
    assert.deepEqual(
      parseOAuthResponse(
        JSON.stringify({ access_token: "a", expires_at: now + 1234 }),
        "existing-refresh",
        now,
      ),
      {
        accessToken: "a",
        refreshToken: "existing-refresh",
        expiresAt: now + 1234,
      },
    )
    assert.equal(
      parseOAuthResponse(
        JSON.stringify({ access_token: "a", expires_in: 10 }),
        "r",
        now,
      )?.expiresAt,
      now + 10_000,
    )
    assert.equal(
      parseOAuthResponse(JSON.stringify({ access_token: "a" }), "r", now),
      null,
    )
    assert.equal(
      parseOAuthResponse('{"access_token":"a","expires_in":1e309}', "r", now),
      null,
    )
    assert.equal(parseOAuthResponse("null", "r", now), null)
    assert.equal(
      parseOAuthResponse(
        JSON.stringify({
          access_token: "a",
          refresh_token: "   ",
          expires_in: 10,
        }),
        "r",
        now,
      ),
      null,
    )
  })
})

describe("credential refresh coordination", () => {
  it("adopts a distinct usable source credential", async () => {
    const original = createOAuthCredential(account())
    const adopted = await adoptExternalCredential(original, {
      readSource: async () => ({
        accessToken: "external-access",
        refreshToken: "external-refresh",
        expiresAt: Date.now() + 3600_000,
      }),
    })
    assert.equal(adopted.kind, "adopted")
    assert.equal(adopted.credential.access, "external-access")
  })

  it("does not resurrect the stale source left by a failed write", async () => {
    const original = createOAuthCredential(account())
    const refreshed = await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(() => account().credentials, {
        writeSource: async () => "failed",
      }),
    )
    assert.equal(refreshed.kind, "refreshed")
    assert.equal(refreshed.credential.access, "new-access")
    assert.equal(
      (
        await adoptExternalCredential(refreshed.credential, {
          readSource: async () => account().credentials,
        })
      ).kind,
      "unchanged",
    )
  })

  it("does not retry a write the store already decided against", async () => {
    const original = createOAuthCredential(account())
    let writes = 0
    await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(() => account().credentials, {
        writeSource: async () => {
          writes++
          return "failed"
        },
      }),
    )
    // "failed" is a decision about the stored blob; repeating the whole
    // guarded sequence reaches the same conclusion.
    assert.equal(writes, 1)
  })

  it("waits for the lock holder's credential when the lease is lost", async () => {
    const original = createOAuthCredential(account())
    let stored = account().credentials
    let exchanges = 0
    let slept = 0
    const deps = credentialDependencies(() => stored, {
      acquireLock: fakeLock({ extend: false }),
      fetch: async () => {
        exchanges++
        return successfulResponse()
      },
      lockWaitMs: 1_000,
      sleep: async () => {
        slept++
        if (slept === 2) {
          stored = {
            accessToken: "holder-access",
            refreshToken: "holder-refresh",
            expiresAt: Date.now() + 60_000,
          }
        }
      },
    })
    const refreshed = await refreshClaudeCredentialDetailed(original, deps)
    assert.equal(refreshed.kind, "adopted")
    assert.equal(refreshed.credential.access, "holder-access")
    assert.equal(exchanges, 0, "must not spend a refresh token it cannot hold")
    assert.equal(slept, 2)
  })

  it("reports transient when no external credential arrives before the deadline", async () => {
    const original = createOAuthCredential(account())
    let clock = Date.now()
    const refreshed = await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(() => account().credentials, {
        acquireLock: () => ({ kind: "busy" }),
        lockWaitMs: 600,
        now: () => clock,
        sleep: async () => {
          clock += 250
        },
      }),
    )
    assert.equal(refreshed.kind, "transient")
  })

  it("shares one exchange between concurrent refreshes", async () => {
    const original = createOAuthCredential(account())
    let releaseFetch!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    let fetches = 0
    const deps = credentialDependencies(() => account().credentials, {
      fetch: async () => {
        fetches++
        await gate
        return successfulResponse()
      },
    })
    const first = refreshClaudeCredentialDetailed(original, deps)
    const second = refreshClaudeCredentialDetailed(original, deps)
    releaseFetch()
    const [a, b] = await Promise.all([first, second])
    assert.equal(fetches, 1)
    assert.equal(a.credential.access, "new-access")
    assert.equal(b.credential.access, "new-access")
  })

  it("coordinates different credential generations for one source", async () => {
    const first = createOAuthCredential(account())
    const second = createOAuthCredential({
      ...account("Claude Code-credentials", "latest-expired"),
      label: "Second persisted label",
      credentials: {
        accessToken: "latest-expired",
        refreshToken: "latest-refresh",
        expiresAt: Date.now() - 1,
      },
    })
    const stored = {
      accessToken: "latest-expired",
      refreshToken: "latest-refresh",
      expiresAt: Date.now() - 1,
    }
    let releaseFetch!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    let fetches = 0
    const deps = credentialDependencies(() => stored, {
      fetch: async () => {
        fetches++
        await gate
        return successfulResponse()
      },
    })
    const aPromise = refreshClaudeCredentialDetailed(first, deps)
    const bPromise = refreshClaudeCredentialDetailed(second, deps)
    releaseFetch()
    const [a, b] = await Promise.all([aPromise, bPromise])
    assert.equal(fetches, 1)
    assert.equal(a.credential.access, "new-access")
    assert.equal(b.credential.access, "new-access")
    assert.equal(credentialLabel(b.credential), "Second persisted label")
  })

  it("does not share refreshes between different file sources", async () => {
    const first = createOAuthCredential({
      ...account("file", "first-access"),
      configDir: "/claude/first",
    })
    const second = createOAuthCredential({
      ...account("file", "second-access"),
      configDir: "/claude/second",
    })
    let fetches = 0
    const refresh = (credential: Credential.OAuth) =>
      refreshClaudeCredentialDetailed(
        credential,
        credentialDependencies(
          () => ({
            accessToken: credential.access,
            refreshToken: credential.refresh,
            expiresAt: credential.expires,
          }),
          {
            fetch: async () => {
              fetches++
              return successfulResponse(`${credential.access}-new`)
            },
          },
        ),
      )
    const [a, b] = await Promise.all([refresh(first), refresh(second)])
    assert.equal(fetches, 2)
    assert.equal(a.credential.access, "first-access-new")
    assert.equal(b.credential.access, "second-access-new")
  })

  it("uses one post-lock source snapshot for an expired external rotation", async () => {
    const original = createOAuthCredential(account())
    const latest = {
      accessToken: "latest-expired",
      refreshToken: "latest-refresh",
      expiresAt: Date.now() - 1,
    }
    let reads = 0
    let body: Record<string, unknown> | undefined
    const result = await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(
        () => {
          reads++
          return reads === 1 ? account().credentials : latest
        },
        {
          fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body))
            return successfulResponse()
          },
          writeSource: async (_source, _credentials, _configDir, expected) => {
            assert.equal(expected, "latest-expired")
            return "written"
          },
        },
      ),
    )
    assert.equal(body?.refresh_token, "latest-refresh")
    assert.equal(result.credential.access, "new-access")
  })

  it("defers when another process owns the lock", async () => {
    const original = createOAuthCredential(account())
    const result = await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(() => account().credentials, {
        acquireLock: () => ({ kind: "busy" }),
        lockWaitMs: 0,
      }),
    )
    assert.equal(result.kind, "transient")
    assert.equal(result.credential, original)
  })

  it("returns at once with the cooldown another process is waiting out", async () => {
    const original = createOAuthCredential(account())
    const clock = Date.now()
    let slept = 0
    const result = await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(() => account().credentials, {
        acquireLock: () => ({ kind: "cooldown", until: clock + 20_000 }),
        lockWaitMs: 5_000,
        now: () => clock,
        sleep: async () => {
          slept++
        },
      }),
    )
    // Nobody is refreshing, so polling for their result only adds latency.
    assert.equal(slept, 0)
    assert.deepEqual(result, {
      credential: original,
      kind: "transient",
      retryAfterMs: 20_000,
    })
  })

  // 401 recovery calls refresh first and relies on it to adopt a source
  // rotated outside OpenCode before any cooldown can turn it away.
  it("adopts a rotated source even while another process is cooling down", async () => {
    let fetches = 0
    const result = await refreshClaudeCredentialDetailed(
      createOAuthCredential(account()),
      credentialDependencies(
        () => account(undefined, "rotated-access").credentials,
        {
          acquireLock: () => ({ kind: "cooldown", until: Date.now() + 20_000 }),
          fetch: async () => {
            fetches++
            return successfulResponse()
          },
        },
      ),
    )
    assert.equal(result.kind, "adopted")
    assert.equal(result.credential.access, "rotated-access")
    assert.equal(fetches, 0)
  })

  it("adopts a rotated source even during its own cooldown", async () => {
    const original = createOAuthCredential(account())
    let stored = account().credentials
    let fetches = 0
    const deps = credentialDependencies(() => stored, {
      fetch: async () => {
        fetches++
        return rateLimited()
      },
    })
    const failed = await refreshClaudeCredentialDetailed(original, deps)
    assert.equal(failed.kind, "transient")

    stored = account(undefined, "rotated-access").credentials
    const result = await refreshClaudeCredentialDetailed(original, deps)
    assert.equal(result.kind, "adopted")
    assert.equal(result.credential.access, "rotated-access")
    assert.equal(fetches, 1)
  })

  it("returns the existing credential and observes cooldown after a transient", async () => {
    const original = createOAuthCredential(account())
    let fetches = 0
    const deps = credentialDependencies(() => account().credentials, {
      fetch: async () => {
        fetches++
        return rateLimited("10")
      },
    })
    const first = await refreshClaudeCredentialDetailed(original, deps)
    const second = await refreshClaudeCredentialDetailed(original, deps)
    assert.equal(first.kind, "transient")
    assert.equal(first.credential, original)
    // The endpoint's retry-after becomes the cooldown, and the caller's.
    assert.equal(first.kind === "transient" && first.retryAfterMs, 10_000)
    assert.equal(second.kind, "transient")
    const remaining = second.kind === "transient" ? second.retryAfterMs : 0
    assert.ok(remaining > 0 && remaining <= 10_000, String(remaining))
    assert.equal(fetches, 1)
  })

  it("shares transient cooldown across credential generations", async () => {
    const first = createOAuthCredential(account())
    const second = createOAuthCredential(
      account("Claude Code-credentials", "other-generation"),
    )
    let fetches = 0
    const deps = credentialDependencies(() => null, {
      fetch: async () => {
        fetches++
        return rateLimited()
      },
    })
    assert.equal(
      (await refreshClaudeCredentialDetailed(first, deps)).kind,
      "transient",
    )
    assert.equal(
      (await refreshClaudeCredentialDetailed(second, deps)).kind,
      "transient",
    )
    assert.equal(fetches, 1)
  })

  it("reports a terminal refresh with reauthentication guidance", async () => {
    const original = createOAuthCredential(account())
    await assert.rejects(
      refreshClaudeCredentialDetailed(
        original,
        credentialDependencies(() => account().credentials, {
          fetch: async () => invalidGrant(),
        }),
      ),
      ClaudeAuthTerminalError,
    )
  })

  it("does not apply a stale generation's terminal state to a newer one", async () => {
    const stale = createOAuthCredential(account())
    const current = createOAuthCredential(
      account("Claude Code-credentials", "current-access"),
    )
    await assert.rejects(
      refreshClaudeCredentialDetailed(
        stale,
        credentialDependencies(() => null, {
          fetch: async () => invalidGrant(),
        }),
      ),
      ClaudeAuthTerminalError,
    )
    const refreshed = await refreshClaudeCredentialDetailed(
      current,
      credentialDependencies(() => null),
    )
    assert.equal(refreshed.kind, "refreshed")
    assert.equal(refreshed.credential.access, "new-access")
  })

  it("lets a newer generation refresh itself after joining a dead leader", async () => {
    const stale = createOAuthCredential(account())
    const current = createOAuthCredential(
      account("Claude Code-credentials", "current-access"),
    )
    let releaseFetch!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    const bodies: string[] = []
    const deps = credentialDependencies(() => null, {
      fetch: async (_input, init) => {
        const body = String(init?.body)
        bodies.push(body)
        if (bodies.length === 1) {
          await gate
          return invalidGrant()
        }
        return successfulResponse()
      },
    })
    const leader = refreshClaudeCredentialDetailed(stale, deps)
    const joiner = refreshClaudeCredentialDetailed(current, deps)
    releaseFetch()
    await assert.rejects(leader, ClaudeAuthTerminalError)
    const refreshed = await joiner
    assert.equal(refreshed.kind, "refreshed")
    assert.equal(refreshed.credential.access, "new-access")
    assert.equal(bodies.length, 2)
  })

  it("reports repeated transient failures without demanding re-authentication", async () => {
    const original = createOAuthCredential(account())
    let clock = Date.now()
    let fetches = 0
    let recovered = false
    const deps = credentialDependencies(() => account().credentials, {
      now: () => clock,
      fetch: async () => {
        fetches++
        return recovered
          ? successfulResponse()
          : new Response("{}", { status: 503 })
      },
    })
    for (let attempt = 1; attempt < MAX_CONSECUTIVE_TRANSIENT; attempt++) {
      assert.equal(
        (await refreshClaudeCredentialDetailed(original, deps)).kind,
        "transient",
      )
      clock += 61_000
    }
    const exhausted = await refreshClaudeCredentialDetailed(
      original,
      deps,
    ).then(
      () => assert.fail("expected the ceiling to surface an error"),
      (error: unknown) => error,
    )
    assert.ok(exhausted instanceof ClaudeAuthRefreshExhaustedError)
    assert.match(exhausted.message, /failed 10 times in a row \(HTTP 503\)/)
    assert.doesNotMatch(exhausted.message, /Run `claude`/)
    assert.equal(fetches, MAX_CONSECUTIVE_TRANSIENT)

    // The refresh token was never rejected, so once the outage ends the next
    // attempt after the cooldown goes through instead of staying blocked.
    recovered = true
    clock += 61_000
    const refreshed = await refreshClaudeCredentialDetailed(original, deps)
    assert.equal(refreshed.kind, "refreshed")
    assert.equal(fetches, MAX_CONSECUTIVE_TRANSIENT + 1)
  })

  it("does not spend the refresh token while the source cannot be read", async () => {
    const original = createOAuthCredential(account())
    let fetches = 0
    const result = await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(() => null, {
        readSource: async () => {
          throw new Error("macOS Keychain is locked")
        },
        fetch: async () => {
          fetches++
          return successfulResponse()
        },
      }),
    )
    // Refreshing now would rotate the token Claude Code holds without any way
    // to write the replacement back.
    assert.equal(result.kind, "transient")
    assert.equal(fetches, 0)
  })

  it("names the unreadable source once retries run out", async () => {
    const original = createOAuthCredential(account())
    let clock = Date.now()
    const deps = credentialDependencies(() => null, {
      now: () => clock,
      readSource: async () => {
        throw new Error("macOS Keychain is locked")
      },
    })
    for (let attempt = 1; attempt < MAX_CONSECUTIVE_TRANSIENT; attempt++) {
      await refreshClaudeCredentialDetailed(original, deps)
      clock += 61_000
    }
    await assert.rejects(
      refreshClaudeCredentialDetailed(original, deps),
      /Keychain is locked/,
    )
  })

  it("warns that Claude Code will be signed out when write-back fails", async () => {
    const original = createOAuthCredential(account())
    await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(() => account().credentials, {
        writeSource: async () => "failed",
      }),
    )
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /could not be saved/)
  })

  it("does not warn when write-back lands", async () => {
    await refreshClaudeCredentialDetailed(
      createOAuthCredential(account()),
      credentialDependencies(() => account().credentials),
    )
    assert.deepEqual(warnings, [])
  })

  it("keeps the source hash when the store stays unreachable", async () => {
    const original = createOAuthCredential(account())
    let writes = 0
    const refreshed = await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(() => account().credentials, {
        writeSource: async () => {
          writes++
          return "unavailable"
        },
      }),
    )
    assert.equal(writes, 1, "the store retries; this layer does not")
    assert.equal(refreshed.kind, "refreshed")
    assert.equal(
      readMetadata(refreshed.credential)?.sourceTokenHash,
      tokenFingerprint("old-access"),
    )
  })

  it("keeps its own refresh when a conflicting winner is not adoptable", async () => {
    const original = createOAuthCredential(account())
    let source = account().credentials
    const refreshed = await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(() => source, {
        writeSource: async () => {
          source = {
            accessToken: "expired-winner",
            refreshToken: "r",
            expiresAt: Date.now() - 1,
          }
          return "conflict"
        },
      }),
    )
    assert.equal(refreshed.kind, "refreshed")
    assert.equal(refreshed.credential.access, "new-access")
    assert.equal(
      readMetadata(refreshed.credential)?.sourceTokenHash,
      tokenFingerprint("old-access"),
    )
  })

  it("adopts a rotated source instead of failing on invalid_grant", async () => {
    const original = createOAuthCredential(account())
    let source = account().credentials
    const result = await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(() => source, {
        fetch: async () => {
          source = {
            accessToken: "rotated-access",
            refreshToken: "rotated-refresh",
            expiresAt: Date.now() + 3600_000,
          }
          return invalidGrant()
        },
      }),
    )
    assert.equal(result.kind, "adopted")
    assert.equal(result.credential.access, "rotated-access")
  })

  it("releases the lock on every path and defers it after a transient", async () => {
    const events: string[] = []
    const spyLock = (): LockAttempt => ({
      kind: "held",
      lock: {
        extend: () => true,
        defer: (ms: number) => events.push(`defer:${ms}`),
        release: () => events.push("release"),
        degraded: false,
      },
    })
    await refreshClaudeCredentialDetailed(
      createOAuthCredential(account()),
      credentialDependencies(() => account().credentials, {
        acquireLock: spyLock,
        fetch: async () => rateLimited("10"),
      }),
    )
    assert.deepEqual(events, ["defer:10000", "release"])

    events.length = 0
    resetRefreshBackoffState()
    await assert.rejects(
      refreshClaudeCredentialDetailed(
        createOAuthCredential(account()),
        credentialDependencies(() => account().credentials, {
          acquireLock: spyLock,
          fetch: async () => invalidGrant(),
        }),
      ),
      ClaudeAuthTerminalError,
    )
    assert.deepEqual(events, ["release"])
  })

  it("clears terminal state when the account is imported again", async () => {
    const original = createOAuthCredential(account())
    const terminalDeps = credentialDependencies(() => account().credentials, {
      fetch: async () => invalidGrant(),
    })
    await assert.rejects(
      refreshClaudeCredentialDetailed(original, terminalDeps),
      ClaudeAuthTerminalError,
    )

    const imported = createOAuthCredential(account())
    const refreshed = await refreshClaudeCredentialDetailed(
      imported,
      credentialDependencies(() => account().credentials),
    )
    assert.equal(refreshed.kind, "refreshed")
  })

  it("adopts the winning source after a write-back conflict", async () => {
    const original = createOAuthCredential(account())
    let source = account().credentials
    const winner = {
      accessToken: "winner-access",
      refreshToken: "winner-refresh",
      expiresAt: Date.now() + 3600_000,
    }
    const result = await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(() => source, {
        writeSource: async () => {
          source = winner
          return "conflict"
        },
      }),
    )
    assert.equal(result.kind, "adopted")
    assert.equal(result.credential.access, "winner-access")
  })
})
