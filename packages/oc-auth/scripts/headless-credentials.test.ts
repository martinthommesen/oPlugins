import {
  Array as Arr,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
} from "effect"
import {
  NodeCrypto,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node-shared"
import { expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import ClaudeCodeStores from "#src/claude-code-stores.ts"
import CredentialRefresh from "#src/credential-refresh.ts"
import FakeKeychain from "#src/fake-keychain.test-support.ts"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import accountMethod from "#src/claude-code-account-method.ts"
import copy from "./headless-credentials.test-support.ts"
import credentials from "./headless-credentials.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<Layer.Success<typeof layer> | Scope.Scope>
}

type Refreshing = Effect.Success<ReturnType<typeof copy.refreshIn>>

/** Where a live run's copy is. */
interface Sandbox {
  readonly root: string
  readonly store: { readonly configDir: string }
  readonly stored: string
  readonly text: string
}

/** A live run's settings: no `--offline`, and no disposable config directory. */
const COPIED = { offline: false, refreshConfigDir: Option.none<string>() },
  CREDENTIALS_FILE = ".credentials.json",
  ONE_REQUEST = 1,
  /* A sandbox holding a live run's copy of the account, and its credentials file. */
  copied = Effect.gen(function* copied() {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      root = yield* fs.makeTempDirectoryScoped({ prefix: "oc-auth-headless-" }),
      store = yield* credentials.prepare(root, COPIED),
      stored = path.join(store.configDir, CREDENTIALS_FILE)

    return { root, store, stored, text: yield* fs.readFileString(stored) }
  }),
  /* The host's credential for the copy in `context`, imported as `/connect` does. */
  importedFrom = Effect.fn("test.importedFrom")(function* importedFrom(
    context: Refreshing,
  ) {
    const accounts = yield* Context.get(context, ClaudeCodeStores).readAccounts

    return yield* Option.match(Arr.head(accounts), {
      onNone: () => Effect.die("the sandbox holds no account"),
      onSome: (first) =>
        accountMethod.importAccount(first).pipe(Effect.provideContext(context)),
    })
  }, Effect.orDie),
  /** Node's platform, the captured log, and the account to copy. */
  layer = Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer,
    NodeCrypto.layer,
    CapturedLogs.layer,
    FakeKeychain.layer,
    copy.stores,
  ),
  /*
   * Refresh the copy in `sandbox` as a 401 would, with the fake token
   * endpoint recording what it gets in `bodies`.
   */
  refreshOf = Effect.fn("test.refreshOf")(function* refreshOf(
    sandbox: Sandbox,
    bodies: Ref.Ref<readonly string[]>,
  ) {
    const context = yield* copy.refreshIn({
        bodies,
        configDir: sandbox.store.configDir,
        root: sandbox.root,
      }),
      credential = yield* importedFrom(context)

    return yield* Context.get(context, CredentialRefresh)
      .refresh(credential)
      .pipe(Effect.exit)
  }),
  /*
   * A live run's copy, refreshed as a 401 would: how the refresh ended, the
   * bodies the token endpoint got, and the credentials file before and after.
   */
  refreshedCopy = Effect.gen(function* refreshedCopy() {
    const bodies = yield* Ref.make<readonly string[]>([]),
      fs = yield* FileSystem.FileSystem,
      sandbox = yield* copied,
      tried = yield* refreshOf(sandbox, bodies),
      written = yield* fs.readFileString(sandbox.stored)

    return {
      after: written,
      before: sandbox.text,
      exit: tried,
      sent: yield* Ref.get(bodies),
    }
  })

test.layer(layer)("live host test copies of an account", (it: Tests) => {
  it.effect("copies the account's access token without its refresh token", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const sandbox = yield* copied

      expect(sandbox.store.copied).toBe(true)
      expect(sandbox.text).toContain(copy.account.credentials.accessToken)
      expect(sandbox.text).not.toContain(copy.ACCOUNT_REFRESH)
    }),
  )
})

test.layer(layer)("live host test refreshes of a copy", (it: Tests) => {
  it.effect("can't spend the account's refresh token or rotate the copy", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const refreshed = yield* refreshedCopy

      // The refresh reached the token endpoint only with the copy's placeholder.
      expect(refreshed.sent).toHaveLength(ONE_REQUEST)
      expect(
        refreshed.sent.some((body) => body.includes(copy.ACCOUNT_REFRESH)),
      ).toBe(false)
      // Nothing rotated, so nothing was written to the sandbox.
      expect(refreshed.after).toBe(refreshed.before)
      expect(Exit.isFailure(refreshed.exit)).toBe(true)
    }),
  )
})
