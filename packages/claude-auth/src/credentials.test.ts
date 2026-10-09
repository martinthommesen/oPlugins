import type { Credential } from "@opencode/plugin"
import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import {
  adoptExternalCredential,
  authorizeAccount,
  buildAccountForm,
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

function fakeLock(options: { extend?: boolean } = {}) {
  return () => ({
    extend: () => options.extend ?? true,
    defer() {},
    release() {},
    degraded: false,
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
})

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

  it("imports the selected startup account with label and source metadata", async () => {
    const accounts = [account(ACCOUNT_A), account(ACCOUNT_B, "two-access")]
    const credential = await authorizeAccount(
      accounts,
      { account: ACCOUNT_B },
      {
        readAccounts: async () => accounts,
      },
    )
    assert.equal(credential.type, "oauth")
    assert.equal(credential.methodID, METHOD_ID)
    assert.equal(credential.access, "two-access")
    assert.equal(credentialLabel(credential), `Claude Pro: ${ACCOUNT_B}`)
    assert.deepEqual(readMetadata(credential), {
      source: ACCOUNT_B,
      configDir: `/claude/${ACCOUNT_B}`,
      accountLabel: `Claude Pro: ${ACCOUNT_B}`,
      sourceTokenHash: tokenFingerprint("two-access"),
    })
    assert.equal(
      JSON.stringify(credential.metadata).includes("two-access"),
      false,
    )
  })

  it("fails closed when the selected account disappeared", async () => {
    const accounts = [account(ACCOUNT_A), account(ACCOUNT_B)]
    await assert.rejects(
      authorizeAccount(
        accounts,
        { account: ACCOUNT_B },
        {
          readAccounts: async () => [accounts[0]],
        },
      ),
      /no longer available/,
    )
  })

  it("requires an explicit valid answer for a multiple-account form", async () => {
    const accounts = [account(ACCOUNT_A), account(ACCOUNT_B)]
    await assert.rejects(
      authorizeAccount(accounts, {}, { readAccounts: async () => accounts }),
      /Select a registered/,
    )
    await assert.rejects(
      authorizeAccount(
        accounts,
        { account: true },
        { readAccounts: async () => accounts },
      ),
      /Select a registered/,
    )
  })

  it("does not expose accounts added after registration", async () => {
    const startup = [account(ACCOUNT_A)]
    const imported = await authorizeAccount(
      startup,
      {},
      {
        readAccounts: async () => [account(ACCOUNT_C), startup[0]],
      },
    )
    assert.equal(readMetadata(imported)?.source, ACCOUNT_A)
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

  it("retries an unreachable write-back against the same guard token", async () => {
    const original = createOAuthCredential(account())
    const expectations: string[] = []
    const refreshed = await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(() => account().credentials, {
        writeSource: async (_source, _credentials, _configDir, expected) => {
          expectations.push(expected)
          // "unavailable" is the store-unreachable case, the only one a
          // retry can resolve.
          return expectations.length === 1 ? "unavailable" : "written"
        },
      }),
    )
    assert.deepEqual(expectations, ["old-access", "old-access"])
    assert.equal(refreshed.kind, "refreshed")
    assert.equal(
      readMetadata(refreshed.credential)?.sourceTokenHash,
      tokenFingerprint("new-access"),
    )
  })

  it("adopts instead of overwriting a source that rotated during a failed write", async () => {
    // The write fails for its own reasons (a Keychain subprocess timeout),
    // and the user runs `claude` before the retry. Re-reading the guard token
    // here would compare the source against itself and destroy that login.
    const original = createOAuthCredential(account())
    let stored = account().credentials
    const expectations: string[] = []
    const refreshed = await refreshClaudeCredentialDetailed(
      original,
      credentialDependencies(() => stored, {
        writeSource: async (_source, credentials, _configDir, expected) => {
          expectations.push(expected)
          if (expectations.length === 1) {
            stored = {
              accessToken: "external-access",
              refreshToken: "external-refresh",
              expiresAt: Date.now() + 60_000,
            }
            return "unavailable"
          }
          if (expected !== stored.accessToken) return "conflict"
          stored = credentials
          return "written"
        },
      }),
    )
    assert.deepEqual(expectations, ["old-access", "old-access"])
    assert.equal(refreshed.kind, "adopted")
    assert.equal(refreshed.credential.access, "external-access")
    assert.equal(stored.accessToken, "external-access")
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
        acquireLock: () => null,
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
        acquireLock: () => null,
        lockWaitMs: 0,
      }),
    )
    assert.equal(result.kind, "transient")
    assert.equal(result.credential, original)
  })

  it("returns the existing credential and observes cooldown after a transient", async () => {
    const original = createOAuthCredential(account())
    let fetches = 0
    const deps = credentialDependencies(() => account().credentials, {
      fetch: async () => {
        fetches++
        return new Response('{"error":"rate_limit_error"}', {
          status: 429,
          headers: { "retry-after": "10" },
        })
      },
    })
    const first = await refreshClaudeCredentialDetailed(original, deps)
    const second = await refreshClaudeCredentialDetailed(original, deps)
    assert.equal(first.kind, "transient")
    assert.equal(first.credential, original)
    assert.equal(second.kind, "transient")
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
        return new Response('{"error":"rate_limit_error"}', { status: 429 })
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

  it("surfaces a terminal refresh with reauthentication guidance", async () => {
    const original = createOAuthCredential(account())
    await assert.rejects(
      refreshClaudeCredentialDetailed(
        original,
        credentialDependencies(() => account().credentials, {
          fetch: async () =>
            new Response('{"error":"invalid_grant"}', { status: 400 }),
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
          fetch: async () =>
            new Response('{"error":"invalid_grant"}', { status: 400 }),
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
          return new Response('{"error":"invalid_grant"}', { status: 400 })
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

  it("escalates to terminal after too many consecutive transient failures", async () => {
    const original = createOAuthCredential(account())
    let clock = Date.now()
    let fetches = 0
    const deps = credentialDependencies(() => account().credentials, {
      now: () => clock,
      fetch: async () => {
        fetches++
        return new Response("{}", { status: 503 })
      },
    })
    for (let attempt = 1; attempt < MAX_CONSECUTIVE_TRANSIENT; attempt++) {
      assert.equal(
        (await refreshClaudeCredentialDetailed(original, deps)).kind,
        "transient",
      )
      clock += 61_000
    }
    await assert.rejects(
      refreshClaudeCredentialDetailed(original, deps),
      ClaudeAuthTerminalError,
    )
    assert.equal(fetches, MAX_CONSECUTIVE_TRANSIENT)
    await assert.rejects(
      refreshClaudeCredentialDetailed(original, deps),
      ClaudeAuthTerminalError,
    )
    assert.equal(fetches, MAX_CONSECUTIVE_TRANSIENT)
  })

  it("clears terminal state when the account is imported again", async () => {
    const original = createOAuthCredential(account())
    const terminalDeps = credentialDependencies(() => account().credentials, {
      fetch: async () =>
        new Response('{"error":"invalid_grant"}', { status: 400 }),
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

  it("adopts the winning source after a compare-and-swap conflict", async () => {
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
