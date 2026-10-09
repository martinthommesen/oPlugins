import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  acquireRefreshLock,
  MAX_LOCK_TTL_MS,
  type RefreshLock,
} from "./refresh-lock.ts"
import { captureWarnings, removeTempDirs, tempDir } from "./test-helpers.ts"

const SRC = "Claude Code-credentials"
// First 16 hex of sha256(SRC), pinned as a literal so a change to the ticket
// naming scheme fails here instead of silently orphaning every live lock.
const PREFIX = "claude-auth-refresh-e9c5dce8a55501f4-"

/** Write a ticket as another process would, with a lease ending at `expiresAt`. */
function writeTicket(dir: string, ticket: number, expiresAt: number): string {
  const path = join(dir, `${PREFIX}${ticket}.lock`)
  writeFileSync(path, JSON.stringify({ owner: "other", pid: 1, expiresAt }))
  return path
}

function leaseExpiry(path: string): number {
  return (JSON.parse(readFileSync(path, "utf8")) as { expiresAt: number })
    .expiresAt
}

/** The lock when one was granted, else null. */
function acquire(
  source: string,
  opts: Parameters<typeof acquireRefreshLock>[1],
): RefreshLock | null {
  const attempt = acquireRefreshLock(source, opts)
  return attempt.kind === "held" ? attempt.lock : null
}

describe("refresh-lock", () => {
  let dir: string
  beforeEach(() => {
    dir = tempDir("opencode-claude-auth-lock-")
  })
  afterEach(() => {
    removeTempDirs()
  })

  it("grants the lock to the first caller and denies a second holder", () => {
    const first = acquire(SRC, { dir })
    assert.ok(first, "first caller acquires the lock")
    const second = acquire(SRC, { dir })
    assert.equal(second, null, "a live holder blocks a second acquirer")
    first!.release()
  })

  it("releases the lock so a later caller can acquire it", () => {
    const first = acquire(SRC, { dir })
    assert.ok(first)
    assert.notEqual(first!.degraded, true, "a real lock, not the no-op")
    first!.release()
    const second = acquire(SRC, { dir })
    assert.ok(second, "the lock is available again after release")
    assert.notEqual(second!.degraded, true)
    second!.release()
  })

  it("takes over a stale lock past its TTL", () => {
    const held = acquire(SRC, { dir, ttlMs: 20_000 })
    assert.ok(held)
    // The holder "crashes" without releasing; the lock file lingers. A later
    // acquirer looking from far enough in the future treats it as stale.
    const future = Date.now() + 60_000
    const takeover = acquire(SRC, {
      dir,
      ttlMs: 20_000,
      now: () => future,
    })
    assert.ok(takeover, "a stale lock is taken over")
    assert.notEqual(takeover!.degraded, true)
    takeover!.release()
    held!.release()
  })

  it("does not let a stale holder release its successor's lock", () => {
    const started = Date.now()
    const first = acquire(SRC, {
      dir,
      ttlMs: 1_000,
      now: () => started,
    })
    assert.ok(first)
    const second = acquire(SRC, {
      dir,
      ttlMs: 10_000,
      now: () => started + 2_000,
    })
    assert.ok(second)
    assert.equal(first.extend(30_000), false)
    first.release()
    const third = acquire(SRC, {
      dir,
      ttlMs: 10_000,
      now: () => started + 2_000,
    })
    assert.equal(third, null)
    second.release()
  })

  it("does not take over a lock that is still within its TTL", () => {
    const held = acquire(SRC, { dir, ttlMs: 60_000 })
    assert.ok(held)
    const soon = Date.now() + 1_000
    const denied = acquire(SRC, {
      dir,
      ttlMs: 60_000,
      now: () => soon,
    })
    assert.equal(denied, null, "a fresh lock is respected")
    held!.release()
  })

  it("extends the lease for a refresh longer than the base TTL", () => {
    const started = Date.now()
    const held = acquire(SRC, {
      dir,
      ttlMs: 1_000,
      now: () => started,
    })
    assert.ok(held)
    held.extend(30_000)
    const denied = acquire(SRC, {
      dir,
      ttlMs: 1_000,
      now: () => started + 5_000,
    })
    assert.equal(denied, null)
    held.release()
  })

  it("does not renew an owner after its lease expires", () => {
    let current = Date.now()
    const held = acquire(SRC, {
      dir,
      ttlMs: 1_000,
      now: () => current,
    })
    assert.ok(held)
    current += 2_000
    assert.equal(held.extend(30_000), false)
    held.release()
  })

  it("treats a temporarily unreadable fresh claim as live", () => {
    const held = acquire(SRC, { dir, ttlMs: 60_000 })
    assert.ok(held)
    const [claim] = readdirSync(dir)
    writeFileSync(join(dir, claim), "")
    assert.equal(acquire(SRC, { dir, ttlMs: 60_000 }), null)
    held.release()
  })

  it("preserves a deferred cooldown claim after release", () => {
    const started = Date.now()
    const held = acquire(SRC, {
      dir,
      ttlMs: 1_000,
      now: () => started,
    })
    assert.ok(held)
    held.defer(30_000)
    held.release()
    assert.equal(
      acquire(SRC, {
        dir,
        ttlMs: 1_000,
        now: () => started + 5_000,
      }),
      null,
    )
    const later = acquire(SRC, {
      dir,
      ttlMs: 1_000,
      now: () => started + 31_000,
    })
    assert.ok(later)
    later.release()
  })

  it("reports a claim another process is refreshing under as busy", () => {
    const first = acquire(SRC, { dir })!
    assert.deepEqual(acquireRefreshLock(SRC, { dir }), { kind: "busy" })
    first.release()
  })

  it("reports a deferred claim as a cooldown that ends with its lease", () => {
    const T = 1_000_000
    const held = acquire(SRC, { dir, ttlMs: 1_000, now: () => T })!
    held.defer(30_000)
    held.release()
    // Nobody is refreshing, so a caller should not wait for a result that
    // will not come: it is told how long the cooldown has left instead.
    assert.deepEqual(acquireRefreshLock(SRC, { dir, now: () => T + 5_000 }), {
      kind: "cooldown",
      until: T + 30_000,
    })
  })

  it("keeps locks for different sources independent", () => {
    const a = acquire("source-a", { dir })
    const b = acquire("source-b", { dir })
    assert.ok(a, "source-a acquires")
    assert.ok(b, "source-b acquires independently")
    assert.notEqual(a!.degraded, true)
    assert.notEqual(b!.degraded, true)
    assert.equal(
      readdirSync(dir).filter((file) => file.endsWith(".lock")).length,
      2,
      "each source holds its own ticket",
    )
    a!.release()
    b!.release()
  })

  it("keeps an expired ticket until a successor commits", () => {
    const lock = acquire(SRC, { dir })
    assert.ok(lock)
    assert.equal(readdirSync(dir).length, 1, "a lock file exists while held")
    lock!.release()
    const releasedTicket = readdirSync(dir).find((file) =>
      file.endsWith(".lock"),
    )
    assert.ok(releasedTicket, "release leaves an ordering tombstone")

    const successor = acquire(SRC, { dir })
    assert.ok(successor)
    const tickets = readdirSync(dir).filter((file) => file.endsWith(".lock"))
    assert.equal(tickets.length, 1)
    assert.notEqual(tickets[0], releasedTicket)
    successor!.release()
  })

  it("degrades to a marked no-op lock when the lock dir is unusable", () => {
    // Point at a path whose parent is a file, so mkdir/open cannot create the
    // lock. The lock must never block a refresh, so it grants a no-op handle.
    const filePath = join(dir, "not-a-dir")
    // create a regular file, then use a path underneath it as the lock dir
    writeFileSync(filePath, "x")
    const lockDir = join(filePath, "sub")
    const { lines: warnings, restore } = captureWarnings()
    const lock = acquire(SRC, { dir: lockDir })
    restore()
    // Uncoordinated refreshes can burn the shared refresh token, so the user
    // hears about it even with the debug log off.
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /not coordinated/)
    assert.ok(lock, "an unusable lock dir degrades to a granted no-op lock")
    // Without this the degraded lock is indistinguishable from a real one,
    // and a caller cannot tell that nothing is being serialized.
    assert.equal(lock!.degraded, true)
    const second = acquire(SRC, { dir: lockDir })
    assert.equal(
      second!.degraded,
      true,
      "degradation grants every caller at once",
    )
    lock!.release()
    second!.release()
    assert.ok(!existsSync(lockDir))
  })

  it("caps a lease so a mistyped TTL cannot block refreshes for days", () => {
    const lock = acquire(SRC, { dir, ttlMs: 10 * 60 * 60 * 1000 })
    assert.ok(lock)
    const past = Date.now() + MAX_LOCK_TTL_MS + 1_000
    const later = acquire(SRC, { dir, now: () => past })
    assert.ok(later, "the capped lease expires and a successor takes over")
    later!.release()
    lock!.release()
  })

  it("backs off when a live claim appears while racing for the next ticket", () => {
    const T = 1_000_000
    writeTicket(dir, 5, 0)
    let injected = false
    const racing = acquire(SRC, {
      dir,
      ttlMs: 20_000,
      // The first clock read follows the initial scan and precedes the
      // exclusive create of ticket 6, so this is the race window.
      now: () => {
        if (!injected) {
          injected = true
          writeTicket(dir, 6, T + 60_000)
        }
        return T
      },
    })
    // Without the EEXIST rescan this either throws into a degraded lock or
    // takes ticket 7 over a live holder, and two processes refresh at once.
    assert.equal(racing, null, "the live claim that won the race is honored")
    assert.deepEqual(readdirSync(dir).sort(), [
      `${PREFIX}5.lock`,
      `${PREFIX}6.lock`,
    ])
  })

  it("skips past a ticket that was taken but is already expired", () => {
    const T = 1_000_000
    writeTicket(dir, 5, 0)
    let injected = false
    const lock = acquire(SRC, {
      dir,
      ttlMs: 20_000,
      now: () => {
        if (!injected) {
          injected = true
          writeTicket(dir, 6, 0)
        }
        return T
      },
    })
    assert.ok(lock, "an expired claim does not block the retry")
    assert.notEqual(lock.degraded, true)
    // Ticket 6 was lost to the race, so the claim lands on 7, and the commit
    // sweep then removes the expired tombstones below it.
    assert.deepEqual(readdirSync(dir), [`${PREFIX}7.lock`])
    lock.release()
  })

  it("withdraws a claim when a later ticket is committed meanwhile", () => {
    const T = 1_000_000
    let injected = false
    const ownTicket = join(dir, `${PREFIX}1.lock`)
    const loser = acquire(SRC, {
      dir,
      ttlMs: 20_000,
      // The first clock read after this caller's ticket exists is the lease
      // write, which precedes the post-commit supersession scan.
      now: () => {
        if (!injected && existsSync(ownTicket)) {
          injected = true
          writeTicket(dir, 2, T + 60_000)
        }
        return T
      },
    })
    assert.equal(loser, null, "a higher committed ticket wins")
    assert.ok(injected, "the later ticket really appeared after our create")
    assert.equal(
      leaseExpiry(ownTicket),
      0,
      "the withdrawn claim is expired so it blocks nobody",
    )

    // Once the winner is done, the loser's leftover must not hold anyone up.
    writeTicket(dir, 2, 0)
    const next = acquire(SRC, { dir, now: () => T })
    assert.ok(next, "a withdrawn ticket leaves no live claim behind")
    assert.notEqual(next.degraded, true)
    assert.deepEqual(readdirSync(dir), [`${PREFIX}3.lock`])
    next.release()
  })

  it("ignores lock files whose ticket is not a number", () => {
    const T = 1_000_000
    const stray = [`${PREFIX}abc.lock`, `${PREFIX}1x.lock`, `${PREFIX}.lock`]
    for (const name of stray) {
      writeFileSync(join(dir, name), JSON.stringify({ expiresAt: T + 60_000 }))
    }
    const lock = acquire(SRC, { dir, now: () => T })
    // A non-numeric name reaching BigInt() throws inside the scan, which would
    // produce a degraded lock that serializes nothing.
    assert.ok(lock, "stray files with live leases do not block acquisition")
    assert.notEqual(lock.degraded, true)
    assert.deepEqual(
      readdirSync(dir).sort(),
      [...stray, `${PREFIX}1.lock`].sort(),
      "the stray files are left alone and the first ticket is 1",
    )
    lock.release()
  })

  it("will not revive a lease it no longer owns", () => {
    const first = acquire(SRC, { dir, ttlMs: 20_000 })
    assert.ok(first)
    const future = Date.now() + 60_000
    const successor = acquire(SRC, {
      dir,
      ttlMs: 20_000,
      now: () => future,
    })
    assert.ok(successor, "the stale claim is superseded")

    // The stale holder tries to keep its claim alive on the way out.
    first!.defer(60_000)
    const after = acquire(SRC, { dir, now: () => future })
    assert.equal(after, null, "the successor still holds the lock")
    successor!.release()
    first!.release()
  })
})
