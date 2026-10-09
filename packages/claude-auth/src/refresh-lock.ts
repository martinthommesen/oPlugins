/**
 * Best-effort cross-process single flight for rotating OAuth refresh tokens.
 *
 * Lock files are monotonically numbered source-local tickets. Creating the next
 * ticket with O_EXCL is the contention point, though it does not settle the
 * winner on its own: a post-create supersession check can still withdraw the
 * claim. Released tickets stay as expired tombstones until a successor exists,
 * so ticket numbers never reset and a stale holder can never target its
 * successor's path.
 *
 * Coordination is best-effort, not guaranteed. When the lock directory is
 * unusable the module degrades to a lock that serializes nothing, because
 * refusing to refresh would be the worse failure. That degradation is reported
 * as `refresh_lock_degraded` and marked on the lock so callers and tests can
 * tell it apart from a real acquisition.
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
import { errorMessage, log } from "./logger.ts"

/** Ceiling for a lease, so a mistyped TTL cannot park refreshes for days. */
export const MAX_LOCK_TTL_MS = 120_000

export const DEFAULT_LOCK_TTL_MS = Math.min(
  MAX_LOCK_TTL_MS,
  positiveIntFromEnv("OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_TTL_MS", 20_000),
)

/**
 * Fixed payload width. A lease is rewritten in place, so a constant length
 * keeps a concurrent reader from observing a truncated or half-overwritten
 * claim and falling back to the mtime heuristic. JSON.parse ignores the pad.
 */
const LEASE_BYTES = 256

export interface RefreshLock {
  extend(ms: number): boolean
  defer(ms: number): void
  release(): void
  /** True when the lock serializes nothing because coordination is unavailable. */
  degraded: boolean
}

export interface AcquireOptions {
  dir?: string
  ttlMs?: number
  now?: () => number
}

interface Claim {
  ticket: bigint
  expiresAt: number
  path: string
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
 * success because the alternative — failing every refresh on a machine whose
 * lock directory is unwritable — is worse than an uncoordinated refresh.
 */
function degradedLock(source: string, error: unknown): RefreshLock {
  log("refresh_lock_degraded", { source, error: errorMessage(error) })
  return {
    extend: () => true,
    defer() {},
    release() {},
    degraded: true,
  }
}

function readClaim(path: string, ticket: bigint, ttlMs: number): Claim | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      expiresAt?: unknown
    }
    if (
      typeof value.expiresAt === "number" &&
      Number.isFinite(value.expiresAt)
    ) {
      return { ticket, expiresAt: value.expiresAt, path }
    }
  } catch {
    // Initial creation and lease extension briefly expose an empty payload.
  }

  try {
    const modified = statSync(path).mtimeMs
    return { ticket, expiresAt: modified + ttlMs, path }
  } catch {
    return null
  }
}

function hasLiveClaim(claims: Claim[], now: number): boolean {
  return claims.some((claim) => claim.expiresAt >= now)
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

export function acquireRefreshLock(
  source: string,
  opts: AcquireOptions = {},
): RefreshLock | null {
  const dir = opts.dir ?? defaultLockDir()
  const ttlMs = Math.min(MAX_LOCK_TTL_MS, opts.ttlMs ?? DEFAULT_LOCK_TTL_MS)
  const now = opts.now ?? Date.now
  const owner = randomUUID()
  const prefix = lockPrefix(source)

  try {
    // Owner-only: a shared lock directory otherwise lets any local user park
    // a long-lived claim and stall every refresh.
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

  let claims: Claim[]
  try {
    claims = scan()
  } catch (error) {
    return degradedLock(source, error)
  }

  if (hasLiveClaim(claims, now())) return null

  let ticket = highestTicket(claims, 0n)
  let path: string
  let fd: number

  while (true) {
    ticket += 1n
    path = join(dir, `${prefix}${ticket}.lock`)
    try {
      fd = openSync(path, "wx")
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return degradedLock(
          source,
          (error as NodeJS.ErrnoException).code ?? error,
        )
      }
      try {
        claims = scan()
      } catch (scanError) {
        return degradedLock(source, scanError)
      }
      if (hasLiveClaim(claims, now())) return null
      ticket = highestTicket(claims, ticket)
    }
  }

  const writeLease = (expiresAt: number): void => {
    try {
      const payload = JSON.stringify({ owner, pid: process.pid, expiresAt })
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
  // Empty, not the pre-commit `claims`: the sweep below must only act on the
  // post-commit scan, so a failed scan skips the sweep rather than falling
  // back to stale information.
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
  return {
    degraded: false,
    extend(ms: number) {
      if (!ownsTicket()) {
        log("refresh_lock_lost", { source, ticket: ticket.toString() })
        return false
      }
      writeLease(now() + ms)
      // Only the supersession half needs re-checking: the lease was just
      // written by this process, and re-reading it back is the single most
      // expensive syscall on the refresh path.
      if (!stillFirst()) {
        log("refresh_lock_lost", { source, ticket: ticket.toString() })
        return false
      }
      log("refresh_lock_extended", { source, ms })
      return true
    },
    defer(ms: number) {
      // Same ownership check extend() makes: reviving a lease this process no
      // longer holds would republish a claim a successor has moved past.
      if (!ownsTicket()) {
        log("refresh_lock_lost", { source, ticket: ticket.toString() })
        return
      }
      deferred = true
      writeLease(now() + ms)
      log("refresh_lock_deferred", { source, ms })
    },
    release() {
      if (released) return
      released = true
      if (!deferred) writeLease(0)
      try {
        closeSync(fd)
      } catch {
        // already closed
      }
    },
  }
}
