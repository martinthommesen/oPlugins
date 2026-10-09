import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireRefreshLock, MAX_LOCK_TTL_MS } from "./refresh-lock.ts"

const SRC = "Claude Code-credentials"

describe("refresh-lock", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "opencode-claude-auth-lock-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("grants the lock to the first caller and denies a second holder", () => {
    const first = acquireRefreshLock(SRC, { dir })
    assert.ok(first, "first caller acquires the lock")
    const second = acquireRefreshLock(SRC, { dir })
    assert.equal(second, null, "a live holder blocks a second acquirer")
    first!.release()
  })

  it("releases the lock so a later caller can acquire it", () => {
    const first = acquireRefreshLock(SRC, { dir })
    assert.ok(first)
    assert.notEqual(first!.degraded, true, "a real lock, not the no-op")
    first!.release()
    const second = acquireRefreshLock(SRC, { dir })
    assert.ok(second, "the lock is available again after release")
    assert.notEqual(second!.degraded, true)
    second!.release()
  })

  it("takes over a stale lock past its TTL", () => {
    const held = acquireRefreshLock(SRC, { dir, ttlMs: 20_000 })
    assert.ok(held)
    // The holder "crashes" without releasing; the lock file lingers. A later
    // acquirer looking from far enough in the future treats it as stale.
    const future = Date.now() + 60_000
    const takeover = acquireRefreshLock(SRC, {
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
    const first = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 1_000,
      now: () => started,
    })
    assert.ok(first)
    const second = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 10_000,
      now: () => started + 2_000,
    })
    assert.ok(second)
    assert.equal(first.extend(30_000), false)
    first.release()
    const third = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 10_000,
      now: () => started + 2_000,
    })
    assert.equal(third, null)
    second.release()
  })

  it("does not take over a lock that is still within its TTL", () => {
    const held = acquireRefreshLock(SRC, { dir, ttlMs: 60_000 })
    assert.ok(held)
    const soon = Date.now() + 1_000
    const denied = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 60_000,
      now: () => soon,
    })
    assert.equal(denied, null, "a fresh lock is respected")
    held!.release()
  })

  it("extends the lease for a refresh longer than the base TTL", () => {
    const started = Date.now()
    const held = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 1_000,
      now: () => started,
    })
    assert.ok(held)
    held.extend(30_000)
    const denied = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 1_000,
      now: () => started + 5_000,
    })
    assert.equal(denied, null)
    held.release()
  })

  it("does not renew an owner after its lease expires", () => {
    let current = Date.now()
    const held = acquireRefreshLock(SRC, {
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
    const held = acquireRefreshLock(SRC, { dir, ttlMs: 60_000 })
    assert.ok(held)
    const [claim] = readdirSync(dir)
    writeFileSync(join(dir, claim), "")
    assert.equal(acquireRefreshLock(SRC, { dir, ttlMs: 60_000 }), null)
    held.release()
  })

  it("preserves a deferred cooldown claim after release", () => {
    const started = Date.now()
    const held = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 1_000,
      now: () => started,
    })
    assert.ok(held)
    held.defer(30_000)
    held.release()
    assert.equal(
      acquireRefreshLock(SRC, {
        dir,
        ttlMs: 1_000,
        now: () => started + 5_000,
      }),
      null,
    )
    const later = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 1_000,
      now: () => started + 31_000,
    })
    assert.ok(later)
    later.release()
  })

  it("keeps locks for different sources independent", () => {
    const a = acquireRefreshLock("source-a", { dir })
    const b = acquireRefreshLock("source-b", { dir })
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
    const lock = acquireRefreshLock(SRC, { dir })
    assert.ok(lock)
    assert.equal(readdirSync(dir).length, 1, "a lock file exists while held")
    lock!.release()
    const releasedTicket = readdirSync(dir).find((file) =>
      file.endsWith(".lock"),
    )
    assert.ok(releasedTicket, "release leaves an ordering tombstone")

    const successor = acquireRefreshLock(SRC, { dir })
    assert.ok(successor)
    const tickets = readdirSync(dir).filter((file) => file.endsWith(".lock"))
    assert.equal(tickets.length, 1)
    assert.notEqual(tickets[0], releasedTicket)
    successor!.release()
  })

  it("degrades to a marked no-op lock when the lock dir is unusable", () => {
    // Point at a path whose parent is a file, so mkdir/open cannot create the
    // lock. The lock must never block a refresh — it grants a no-op handle.
    const filePath = join(dir, "not-a-dir")
    // create a regular file, then use a path underneath it as the lock dir
    writeFileSync(filePath, "x")
    const lockDir = join(filePath, "sub")
    const lock = acquireRefreshLock(SRC, { dir: lockDir })
    assert.ok(lock, "an unusable lock dir degrades to a granted no-op lock")
    // Without this the degraded lock is indistinguishable from a real one,
    // and a caller cannot tell that nothing is being serialized.
    assert.equal(lock!.degraded, true)
    const second = acquireRefreshLock(SRC, { dir: lockDir })
    assert.equal(
      second!.degraded,
      true,
      "degradation grants every caller at once",
    )
    lock!.release()
    second!.release()
    assert.ok(!existsSync(lockDir))
  })

  it("caps a lease so a mistyped TTL cannot park refreshes for days", () => {
    const lock = acquireRefreshLock(SRC, { dir, ttlMs: 10 * 60 * 60 * 1000 })
    assert.ok(lock)
    const past = Date.now() + MAX_LOCK_TTL_MS + 1_000
    const later = acquireRefreshLock(SRC, { dir, now: () => past })
    assert.ok(later, "the capped lease expires and a successor takes over")
    later!.release()
    lock!.release()
  })

  it("will not revive a lease it no longer owns", () => {
    const first = acquireRefreshLock(SRC, { dir, ttlMs: 20_000 })
    assert.ok(first)
    const future = Date.now() + 60_000
    const successor = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 20_000,
      now: () => future,
    })
    assert.ok(successor, "the stale claim is superseded")

    // The stale holder tries to keep its claim alive on the way out.
    first!.defer(60_000)
    const after = acquireRefreshLock(SRC, { dir, now: () => future })
    assert.equal(after, null, "the successor still holds the lock")
    successor!.release()
    first!.release()
  })
})
