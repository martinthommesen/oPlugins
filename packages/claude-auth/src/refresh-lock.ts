/**
 * Best-effort cross-process single flight for rotating OAuth refresh tokens.
 *
 * Lock files are monotonically numbered source-local tickets. Creating the next
 * ticket with O_EXCL is where processes contend, but it does not settle the
 * winner on its own. A post-create supersession check can still withdraw the
 * claim. Released tickets stay as expired tombstones until a successor exists,
 * so ticket numbers never reset and a stale holder can never target its
 * successor's path.
 *
 * Coordination is best-effort, not guaranteed. When the lock directory is
 * unusable the module degrades to a lock that serializes nothing, because
 * refusing to refresh would be the worse failure. That degradation is reported
 * as a `refresh_lock_degraded` warning and marked on the lock so callers and
 * tests can tell it apart from a real acquisition.
 */
import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import { opencodeDataDir, positiveIntFromEnv } from "./env.ts"
import { errorMessage, log, warn } from "./logger.ts"

/** Ceiling for a lease, so a mistyped TTL cannot block refreshes for days. */
export const MAX_LOCK_TTL_MS = 120_000

const DEFAULT_LOCK_TTL_MS = positiveIntFromEnv(
  "OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_TTL_MS",
  20_000,
)

/**
 * Fixed payload width. A lease is rewritten in place, so a constant length
 * keeps a concurrent reader from observing a truncated or half-overwritten
 * claim and falling back to the mtime heuristic. JSON.parse ignores the pad.
 */
const LEASE_BYTES = 256

/**
 * The outcome of asking for the lock. `busy` means another process is
 * refreshing this source right now; `cooldown` means one is waiting out a
 * failed refresh until `until`, so no new credential is on its way.
 */
export type LockAttempt =
  | { kind: "held"; lock: RefreshLock }
  | { kind: "busy" }
  | { kind: "cooldown"; until: number }

export interface RefreshLock {
  extend(ms: number): boolean
  defer(ms: number): void
  release(): void
  /** True when the lock serializes nothing because coordination is unavailable. */
  degraded: boolean
}

interface AcquireOptions {
  dir?: string
  ttlMs?: number
  now?: () => number
}

interface Claim {
  ticket: bigint
  expiresAt: number
  path: string
  /** Held through `defer`, after a failed refresh, rather than for one. */
  cooldown: boolean
}

function defaultLockDir(): string {
  return process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR ?? opencodeDataDir()
}

function lockPrefix(source: string): string {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16)
  return `claude-auth-refresh-${digest}-`
}

/**
 * The lock returned when the lock directory cannot be used. `extend` reports
 * success because failing every refresh on a machine with an unwritable lock
 * directory would be worse than an uncoordinated refresh.
 */
function degradedLock(source: string, error: unknown): LockAttempt {
  warn(
    "refresh_lock_degraded",
    `token refreshes are not coordinated between OpenCode processes (${errorMessage(error)}); two refreshing at once can sign Claude Code out. Check that the lock directory is writable.`,
    { source },
  )
  return {
    kind: "held",
    lock: {
      extend: () => true,
      defer() {},
      release() {},
      degraded: true,
    },
  }
}

function readClaim(path: string, ticket: bigint, ttlMs: number): Claim | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      expiresAt?: unknown
      cooldown?: unknown
    }
    if (
      typeof value.expiresAt === "number" &&
      Number.isFinite(value.expiresAt)
    ) {
      const cooldown = value.cooldown === true
      return { ticket, expiresAt: value.expiresAt, path, cooldown }
    }
  } catch {
    // A ticket is empty between its creation and the first lease write. Later
    // writes overwrite it in place at a fixed width, so it is never empty again.
  }

  try {
    const modified = statSync(path).mtimeMs
    return { ticket, expiresAt: modified + ttlMs, path, cooldown: false }
  } catch {
    return null
  }
}

/** What the live claims among `claims` say, or null when there are none. */
function contention(claims: Claim[], now: number): LockAttempt | null {
  const live = claims.filter((claim) => claim.expiresAt >= now)
  if (live.length === 0) return null
  if (!live.every((claim) => claim.cooldown)) return { kind: "busy" }
  return {
    kind: "cooldown",
    until: Math.max(...live.map((claim) => claim.expiresAt)),
  }
}

function highestTicket(claims: Claim[], floor: bigint): bigint {
  return claims.reduce(
    (highest, claim) => (claim.ticket > highest ? claim.ticket : highest),
    floor,
  )
}

/** Another process committed a later ticket, or holds a live earlier one. */
function superseded(claims: Claim[], ticket: bigint, now: number): boolean {
  return claims.some(
    (claim) =>
      claim.ticket > ticket ||
      (claim.ticket !== ticket && claim.expiresAt >= now),
  )
}

function remove(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // The claim may already have been removed by another successor.
  }
}

interface TicketClaim {
  fd: number
  path: string
  ticket: bigint
}

/**
 * Create the next ticket after `claims`, or report the live claim that turns
 * up while racing for it. Throws when the directory cannot be used.
 */
function claimNextTicket(
  dir: string,
  prefix: string,
  claims: Claim[],
  scan: () => Claim[],
  now: () => number,
): TicketClaim | LockAttempt {
  let ticket = highestTicket(claims, 0n)
  while (true) {
    ticket += 1n
    const path = join(dir, `${prefix}${ticket}.lock`)
    try {
      return { fd: openSync(path, "wx"), path, ticket }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const latest = scan()
    const contended = contention(latest, now())
    if (contended) return contended
    ticket = highestTicket(latest, ticket)
  }
}

export function acquireRefreshLock(
  source: string,
  opts: AcquireOptions = {},
): LockAttempt {
  const dir = opts.dir ?? defaultLockDir()
  const ttlMs = Math.min(MAX_LOCK_TTL_MS, opts.ttlMs ?? DEFAULT_LOCK_TTL_MS)
  const now = opts.now ?? Date.now
  const prefix = lockPrefix(source)

  try {
    // Owner-only, because in a shared lock directory any local user could
    // hold a long-lived claim and stall every refresh.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // Scanning below determines whether coordination is available.
  }

  const scan = (): Claim[] =>
    readdirSync(dir)
      .map((name): Claim | null => {
        if (!name.startsWith(prefix) || !name.endsWith(".lock")) return null
        const rawTicket = name.slice(prefix.length, -".lock".length)
        if (!/^\d+$/.test(rawTicket)) return null
        const ticket = BigInt(rawTicket)
        return readClaim(join(dir, name), ticket, ttlMs)
      })
      .filter((claim): claim is Claim => claim !== null)

  let claim: TicketClaim | LockAttempt
  try {
    const claims = scan()
    claim =
      contention(claims, now()) ??
      claimNextTicket(dir, prefix, claims, scan, now)
  } catch (error) {
    return degradedLock(source, error)
  }
  if ("kind" in claim) return claim
  const lock = commitClaim(source, claim, { ttlMs, now, scan })
  return lock ? { kind: "held", lock } : { kind: "busy" }
}

/**
 * Publish the lease on a freshly created ticket and hand back the lock, or
 * withdraw and return null when another process committed meanwhile.
 */
function commitClaim(
  source: string,
  { fd, path, ticket }: TicketClaim,
  {
    ttlMs,
    now,
    scan,
  }: { ttlMs: number; now: () => number; scan: () => Claim[] },
): RefreshLock | null {
  const owner = randomUUID()
  const writeLease = (expiresAt: number, cooldown = false): void => {
    try {
      const payload = JSON.stringify({
        owner,
        pid: process.pid,
        expiresAt,
        cooldown,
      })
      writeSync(fd, payload.padEnd(LEASE_BYTES, " "), 0)
    } catch {
      // A concurrent scan treats the fresh claim mtime as a live lease.
    }
  }
  writeLease(now() + ttlMs)

  /** This process's lease is still the one on disk and has not expired. */
  const holdsLease = (): boolean => {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as {
        owner?: unknown
        expiresAt?: unknown
      }
      return (
        value.owner === owner &&
        typeof value.expiresAt === "number" &&
        value.expiresAt > now()
      )
    } catch {
      return false
    }
  }

  /** No other process has committed a later ticket. */
  const stillFirst = (): boolean => {
    try {
      return !superseded(scan(), ticket, now())
    } catch {
      return false
    }
  }

  const ownsTicket = (): boolean => holdsLease() && stillFirst()

  // A delayed contender may recreate a compacted lower ticket. A higher
  // ticket proves another process committed after this caller's first scan,
  // so this claim must withdraw before returning to the refresh path.
  // This starts empty, not with the pre-commit claims. The sweep below must
  // act only on the post-commit scan, so a failed scan skips the sweep
  // instead of falling back to stale information.
  let settled: Claim[] = []
  try {
    const fresh = scan()
    if (superseded(fresh, ticket, now())) {
      writeLease(0)
      closeSync(fd)
      return null
    }
    settled = fresh
  } catch (error) {
    log("refresh_lock_error", { source, error: errorMessage(error) })
    // Filesystem errors degrade to best-effort after this point.
  }

  // The successor ticket now preserves monotonic ordering, so older expired
  // tombstones can be removed without making any ticket reusable. This reads
  // the post-commit scan: the pre-commit one can show a claim as expired that
  // its holder has since revived, and unlinking that file strands the holder.
  for (const claim of settled) {
    if (claim.ticket !== ticket && claim.expiresAt < now()) remove(claim.path)
  }

  log("refresh_lock_acquired", { source, ticket: ticket.toString() })
  let deferred = false
  let released = false
  const lost = () =>
    log("refresh_lock_lost", { source, ticket: ticket.toString() })
  return {
    degraded: false,
    extend(ms: number) {
      if (!ownsTicket()) {
        lost()
        return false
      }
      writeLease(now() + ms)
      // Only the supersession half needs re-checking: the lease was just
      // written by this process, and re-reading it back is the single most
      // expensive syscall on the refresh path.
      if (!stillFirst()) {
        lost()
        return false
      }
      log("refresh_lock_extended", { source, ms })
      return true
    },
    defer(ms: number) {
      // Same ownership check extend() makes: reviving a lease this process no
      // longer holds would republish a claim a successor has moved past.
      if (!ownsTicket()) {
        lost()
        return
      }
      deferred = true
      writeLease(now() + ms, true)
      log("refresh_lock_deferred", { source, ms })
    },
    release() {
      if (released) return
      released = true
      if (!deferred) writeLease(0)
      closeSync(fd)
    },
  }
}
