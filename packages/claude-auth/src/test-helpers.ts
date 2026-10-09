/**
 * Helpers shared between test files. Excluded from the build in
 * `tsconfig.json`, so it is typechecked but never published.
 *
 * Restoring an environment variable has one branch worth getting right. An
 * unset variable has to be restored with `delete`, not `= "undefined"`, and
 * getting it wrong leaks state into sibling tests instead of failing the test
 * that owns it.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setWarningStreamForTests } from "./logger.ts"

/** Set an environment variable, returning a function that restores it. */
export function withEnv(name: string, value: string | undefined): () => void {
  const original = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  return () => {
    if (original === undefined) delete process.env[name]
    else process.env[name] = original
  }
}

/** Override `process.platform`, returning a function that restores it. */
export function withPlatform(platform: string): () => void {
  const original = process.platform
  Object.defineProperty(process, "platform", { value: platform })
  return () => Object.defineProperty(process, "platform", { value: original })
}

/** Collect the user-facing warnings until `restore` is called. */
export function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const restore = setWarningStreamForTests({
    write: (chunk: string) => {
      lines.push(chunk)
      return true
    },
  })
  return { lines, restore }
}

const tempDirs: string[] = []

/**
 * Create a temporary directory that `removeTempDirs` deletes. Call that from
 * an `afterEach`, so a failing test cannot leave directories behind.
 */
export function tempDir(prefix = "opencode-claude-auth-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Delete every directory `tempDir` has created since the last call. */
export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}
