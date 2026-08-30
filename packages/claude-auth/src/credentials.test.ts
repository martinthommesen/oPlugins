import type { Credential } from "@opencode-ai/plugin"
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
import { resetRefreshBackoffState } from "./refresh-backoff.ts"
import type { ClaudeAccount, ClaudeCredentials } from "./keychain.ts"

const now = Date.now()

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

function fakeLock() {
  return { extend: () => true, defer() {}, release() {} }
}

function credentialDependencies(
  stored: () => ClaudeCredentials | null,
  overrides: Partial<CredentialDependencies> = {},
): Partial<CredentialDependencies> {
  return {
    readSource: stored,
    writeSource: () => "written",
    acquireLock: fakeLock,
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
    assert.deepEqual(buildAccountForm([account("one"), account("two")]), [
      {
        key: "account",
        type: "string",
        title: "Claude Code account",
        required: true,
        options: [
          { value: "one", label: "Claude Pro: one" },
          { value: "two", label: "Claude Pro: two" },
        ],
      },
    ])
  })

  it("imports the selected startup account with label and source metadata", () => {
    const accounts = [account("one"), account("two", "two-access")]
    const credential = authorizeAccount(
      accounts,
      { account: "two" },
      {
        readAccounts: () => accounts,
      },
    )
    assert.equal(credential.type, "oauth")
    assert.equal(credential.methodID, METHOD_ID)
    assert.equal(credential.access, "two-access")
    assert.equal(credentialLabel(credential), "Claude Pro: two")
    assert.deepEqual(readMetadata(credential), {
      source: "two",
      configDir: "/claude/two",
      accountLabel: "Claude Pro: two",
      sourceTokenHash: readMetadata(credential)!.sourceTokenHash,
    })
    assert.equal(
      JSON.stringify(credential.metadata).includes("two-access"),
      false,
    )
  })

  it("fails closed when the selected account disappeared", () => {
    const accounts = [account("one"), account("two")]
    assert.throws(
      () =>
        authorizeAccount(
          accounts,
          { account: "two" },
          {
            readAccounts: () => [accounts[0]],
          },
        ),
      /no longer available/,
    )
  })

  it("requires an explicit valid answer for a multiple-account form", () => {
    const accounts = [account("one"), account("two")]
    assert.throws(
      () => authorizeAccount(accounts, {}, { readAccounts: () => accounts }),
      /Select a registered/,
    )
    assert.throws(
      () =>
        authorizeAccount(
          accounts,
          { account: true },
          { readAccounts: () => accounts },
        ),
      /Select a registered/,
    )
  })

  it("does not expose accounts added after registration", () => {
    const startup = [account("one")]
    const imported = authorizeAccount(
      startup,
      {},
      {
        readAccounts: () => [account("new"), startup[0]],
      },
    )
    assert.equal(readMetadata(imported)?.source, "one")
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
  it("adopts a distinct usable source credential", () => {
    const original = createOAuthCredential(account())
    const adopted = adoptExternalCredential(original, {
      readSource: () => ({
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
        writeSource: () => "failed",
      }),
    )
    assert.equal(refreshed.kind, "refreshed")
    assert.equal(refreshed.credential.access, "new-access")
    assert.equal(
      adoptExternalCredential(refreshed.credential, {
        readSource: () => account().credentials,
      }).kind,
      "unchanged",
    )
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
          writeSource: (_source, _credentials, _configDir, expected) => {
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
        writeSource: () => {
          source = winner
          return "conflict"
        },
      }),
    )
    assert.equal(result.kind, "adopted")
    assert.equal(result.credential.access, "winner-access")
  })
})
