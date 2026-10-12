import {
  Array as Arr,
  Cause,
  Context,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Ref,
  Struct,
} from "effect"
import ClaudeCodeStores from "#src/claude-code-stores.ts"
import type { Credential } from "@opencode/plugin/effect"
import FakeIntegration from "#src/fake-integration.test-support.ts"
import accountMethod from "#src/claude-code-account-method.ts"
import copy from "./headless-credentials.test-support.ts"
import credentials from "./headless-credentials.ts"
import plugin from "./headless-plugin.test-support.ts"
import scenario from "#src/plugin-scenario.test-support.ts"
import transforms from "#src/request-transforms.test-support.ts"

type Refreshing = Effect.Success<ReturnType<typeof copy.refreshIn>>

/** A live run's copy, and what the fake token endpoint records. */
interface Copy {
  /** The request bodies the token endpoint got, in order. */
  readonly bodies: Ref.Ref<readonly string[]>
  /** The copy's credentials file, and what it held at first. */
  readonly stored: string
  readonly text: string
}

/** How the host shows its connection to the copy. */
const CONNECTION = scenario
    .ours("copy")
    .pipe(Option.map(Struct.get("connection"))),
  /** A live run's settings: no `--offline`, and no disposable config directory. */
  COPIED = { offline: false, refreshConfigDir: Option.none<string>() },
  CREDENTIALS_FILE = ".credentials.json",
  /* A sandbox holding a live run's copy of the account, and its credentials file. */
  copied = Effect.gen(function* copied() {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      root = yield* fs.makeTempDirectoryScoped({ prefix: "oc-auth-headless-" }),
      store = yield* credentials.prepare(root, COPIED),
      stored = path.join(store.configDir, CREDENTIALS_FILE)

    return { root, store, stored, text: yield* fs.readFileString(stored) }
  }),
  /*
   * A live run's copy, and the plugin's own credential refresh over it,
   * against the fake token endpoint, which records what it gets in
   * `bodies`.
   */
  copyRefreshing = Effect.gen(function* copyRefreshing() {
    const bodies = yield* Ref.make<readonly string[]>([]),
      sandbox = yield* copied

    return {
      bodies,
      refreshing: yield* copy.refreshIn({
        bodies,
        configDir: sandbox.store.configDir,
        root: sandbox.root,
      }),
      sandbox,
    }
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
  /*
   * A live run's copy with the whole plugin set up over it on a fake host,
   * whose active connection is the copy: the plugin's services and the
   * credential the host holds. The plugin refreshes against the fake token
   * endpoint.
   */
  onCopy = Effect.gen(function* onCopy() {
    const base = yield* copyRefreshing,
      imported = yield* importedFrom(base.refreshing),
      services = yield* plugin.over(
        base.refreshing,
        Option.all({ connection: CONNECTION, value: Option.some(imported) }),
      )

    return {
      bodies: base.bodies,
      imported,
      services,
      stored: base.sandbox.stored,
      text: base.sandbox.text,
    }
  }),
  /*
   * What the plugin did with `run`: the bodies the token endpoint got, and
   * the copy's credentials file before and after.
   */
  outcome = Effect.fn("test.outcome")(function* outcome(run: Copy) {
    const fs = yield* FileSystem.FileSystem,
      written = yield* fs.readFileString(run.stored)

    return {
      after: written,
      before: run.text,
      sent: yield* Ref.get(run.bodies),
    }
  }),
  /*
   * The copy after the host called the refresh callback the plugin
   * registered for it, and whether that refresh failed.
   */
  refreshedByHost = Effect.gen(function* refreshedByHost() {
    const live = yield* onCopy,
      method = yield* FakeIntegration.pipe(
        Effect.flatMap((integration) => integration.method),
        Effect.provideContext(live.services),
      ),
      refresh = yield* Effect.fromOption(
        Option.fromUndefinedOr(method.refresh),
      ),
      refreshing: Effect.Effect<Credential.OAuth, Cause.UnknownError> = refresh(
        live.imported,
      ).pipe(Effect.mapError((cause) => new Cause.UnknownError(cause))),
      tried = yield* Effect.exit(refreshing)

    return Struct.assign(yield* outcome(live), {
      failed: Exit.isFailure(tried),
    })
  }),
  /*
   * The copy after a model request got a 401 and the plugin's unauthorized
   * recovery ran, and the response body the caller got.
   */
  rejectedOnce = Effect.gen(function* rejectedOnce() {
    const live = yield* onCopy,
      reply = yield* scenario.send(scenario.messages()).pipe(
        Effect.flatMap((outbound) =>
          scenario.respond(outbound, scenario.unauthorized()),
        ),
        Effect.provideContext(live.services),
      )

    return Struct.assign(yield* outcome(live), {
      reply: yield* transforms.bodyText(reply),
    })
  })

/** A live run's copy of an account, and what the plugin does with it. */
/** @internal */
export default Object.freeze({ copied, refreshedByHost, rejectedOnce })
