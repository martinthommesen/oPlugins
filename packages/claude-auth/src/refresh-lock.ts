/**
 * Best-effort cross-process single flight for rotating OAuth refresh tokens.
 *
 * Lock files are monotonically numbered source-local tickets. Creating the next
 * ticket with O_EXCL is the single atomic winner commit. Released tickets stay
 * as expired tombstones until a successor exists, so ticket numbers never
 * reset and a stale holder can never target its successor's path.
 */
import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log } from "./logger.ts"

export const DEFAULT_LOCK_TTL_MS = (() => {
  const raw = process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_TTL_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000
})()

export interface RefreshLock {
  extend(ms: number): boolean
  defer(ms: number): void
  release(): void
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
  return (
    process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR ??
    join(homedir(), ".local", "share", "opencode")
  )
}

function lockPrefix(source: string): string {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16)
  return `claude-auth-refresh-${digest}-`
}

const NOOP_LOCK: RefreshLock = {
  extend: () => true,
  defer() {},
  release() {},
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
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS
  const now = opts.now ?? Date.now
  const owner = randomUUID()
  const prefix = lockPrefix(source)

  try {
    mkdirSync(dir, { recursive: true })
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
    log("refresh_lock_error", { source, error: String(error) })
    return NOOP_LOCK
  }

  if (claims.some((claim) => claim.expiresAt >= now())) return null

  let ticket = claims.reduce(
    (highest, claim) => (claim.ticket > highest ? claim.ticket : highest),
    0n,
  )
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
        log("refresh_lock_error", {
          source,
          error: String((error as NodeJS.ErrnoException).code ?? error),
        })
        return NOOP_LOCK
      }
      try {
        claims = scan()
      } catch (scanError) {
        log("refresh_lock_error", { source, error: String(scanError) })
        return NOOP_LOCK
      }
      if (claims.some((claim) => claim.expiresAt >= now())) return null
      ticket = claims.reduce(
        (highest, claim) => (claim.ticket > highest ? claim.ticket : highest),
        ticket,
      )
    }
  }

  const writeLease = (expiresAt: number): void => {
    try {
      ftruncateSync(fd, 0)
      writeSync(fd, JSON.stringify({ owner, pid: process.pid, expiresAt }), 0)
    } catch {
      // A concurrent scan treats the fresh claim mtime as a live lease.
    }
  }
  writeLease(now() + ttlMs)

  const ownsTicket = (): boolean => {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as {
        owner?: unknown
        expiresAt?: unknown
      }
      return (
        value.owner === owner &&
        typeof value.expiresAt === "number" &&
        value.expiresAt > now() &&
        !scan().some(
          (claim) =>
            claim.ticket > ticket ||
            (claim.ticket !== ticket && claim.expiresAt >= now()),
        )
      )
    } catch {
      return false
    }
  }

  // A delayed contender may recreate a compacted lower ticket. A higher
  // ticket proves another process committed after this caller's first scan,
  // so this claim must withdraw before returning to the refresh path.
  try {
    if (
      scan().some(
        (claim) =>
          claim.ticket > ticket ||
          (claim.ticket !== ticket && claim.expiresAt >= now()),
      )
    ) {
      writeLease(0)
      closeSync(fd)
      return null
    }
  } catch (error) {
    log("refresh_lock_error", { source, error: String(error) })
    // Filesystem errors degrade to best-effort after this point.
  }

  // The successor ticket now preserves monotonic ordering, so older expired
  // tombstones can be removed without making any ticket reusable.
  for (const claim of claims) {
    if (claim.expiresAt < now()) remove(claim.path)
  }

  log("refresh_lock_acquired", { source, ticket: ticket.toString() })
  let deferred = false
  let released = false
  return {
    extend(ms: number) {
      if (!ownsTicket()) {
        log("refresh_lock_lost", { source, ticket: ticket.toString() })
        return false
      }
      writeLease(now() + ms)
      if (!ownsTicket()) {
        log("refresh_lock_lost", { source, ticket: ticket.toString() })
        return false
      }
      log("refresh_lock_extended", { source, ms })
      return true
    },
    defer(ms: number) {
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
