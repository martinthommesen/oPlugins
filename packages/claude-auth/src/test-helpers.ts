/**
 * Helpers shared between test files. Excluded from the build in
 * `tsconfig.json`, so it is typechecked but never published.
 *
 * Restoring an environment variable has one branch worth getting right —
 * unset has to become `delete`, not `= "undefined"` — and getting it wrong
 * leaks state into sibling tests rather than failing the test that owns it.
 */

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
