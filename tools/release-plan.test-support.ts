import { Array as Arr, Effect, Function as Fn, Schema } from "effect"
import type { Logger, ReleasePullRequest } from "release-please"
import { Manifest } from "release-please"
import type Snapshot from "./snapshot.ts"
import bundling from "./bundling.test-support.ts"
import libraryFingerprints from "./library-fingerprints.ts"
import releasePleaseScm from "./release-please-scm.test-support.ts"

type Layout = typeof Snapshot.Type

type Fingerprint = Effect.Success<
  ReturnType<typeof libraryFingerprints.expected>
>[number]

/** One commit on `main`: its message and the files it changes. */
interface Change {
  readonly files: readonly string[]
  readonly message: string
}

const CONFIG = "release-please-config.json",
  /** A package's release in `release-please-config.json`. */
  Component = Schema.Struct({ component: Schema.String }),
  /** What the plan reads from `release-please-config.json`. */
  Config = Schema.fromJsonString(
    Schema.Struct({ packages: Schema.Record(Schema.String, Component) }),
  ),
  MANIFEST = ".release-please-manifest.json",
  /** One release's notes in a release pull request. */
  Note = Schema.Struct({ notes: Schema.String }),
  /** The version a release pull request releases. */
  Numbers = Schema.Struct({
    major: Schema.Int,
    minor: Schema.Int,
    patch: Schema.Int,
  }),
  /** What the plan reads from a release pull request. */
  Pull = Schema.Struct({
    body: Schema.Struct({ releaseData: Schema.Array(Note) }),
    headRefName: Schema.String,
    version: Numbers,
  }),
  RELEASED = "last-release",
  /** Release-please's logger, quiet. */
  SILENT: Logger = {
    debug: Fn.constVoid,
    error: Fn.constVoid,
    info: Fn.constVoid,
    trace: Fn.constVoid,
    warn: Fn.constVoid,
  },
  /** The marker before the plugin's name in a release branch's name. */
  TAG = "--components--",
  /** `.release-please-manifest.json`: each package's last version. */
  Versions = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
  /* One release pull request: its plugin, version, and whether it breaks. */
  describe = (pull: typeof Pull.Type): string => {
    const { major, minor, patch } = pull.version,
      breaking = pull.body.releaseData.some((release) =>
        release.notes.includes("BREAKING CHANGES"),
      ),
      plugin = pull.headRefName.slice(
        pull.headRefName.indexOf(TAG) + TAG.length,
      ),
      version = `${plugin} ${String(major)}.${String(minor)}.${String(patch)}`

    if (breaking) {
      return `${version}, breaking`
    }

    return version
  },
  /* The tags of the last releases, from the manifest's versions. */
  lastTags = Effect.fn("test.lastTags")(function* lastTags(layout: Layout) {
    const config = yield* Schema.decodeEffect(Config)(
        layout.files[CONFIG] ?? "",
      ),
      versions = yield* Schema.decodeEffect(Versions)(
        layout.files[MANIFEST] ?? "",
      )

    return Object.entries(config.packages).map(
      ([path, release]: readonly [string, { readonly component: string }]) =>
        `${release.component}-v${versions[path] ?? ""}`,
    )
  }, Effect.orDie),
  /*
   * A library change: `message`, changing `file` and each fingerprint the
   * change makes stale, as `pnpm run fingerprints` writes them.
   */
  libraryChange = Effect.fn("test.libraryChange")(function* libraryChange(
    layout: Layout,
    file: string,
    message: string,
  ) {
    const edited = bundling.withFile(
        layout,
        file,
        `${layout.files[file] ?? ""}// Changed.\n`,
      ),
      fresh = yield* libraryFingerprints.expected(edited),
      stale = yield* libraryFingerprints.expected(layout)

    return {
      files: [
        file,
        ...Arr.zip(stale, fresh)
          .filter(
            ([old, now]: readonly [Fingerprint, Fingerprint]) =>
              old.text !== now.text,
          )
          .map(([old]: readonly [Fingerprint, Fingerprint]) => old.file),
      ],
      message,
    } satisfies Change
  }),
  /*
   * The release pull requests release-please plans for `changes`, newest
   * first, on the repository `layout`, through a fake backend that reaches
   * no network. Each reads `<plugin> <version>`, then `, breaking` when its
   * notes list a breaking change.
   */
  plan = Effect.fn("test.plan")(function* plan(
    layout: Layout,
    changes: readonly Change[],
  ) {
    const backend = releasePleaseScm.fakeScm({
        changes: changes.map((change, index) => ({
          files: change.files,
          message: change.message,
          sha: `change-${String(index)}`,
        })),
        files: layout.files,
        released: RELEASED,
        tags: yield* lastTags(layout),
      }),
      loaded = yield* Effect.promise((): PromiseLike<Manifest> =>
        Manifest.fromManifest(backend, "main", CONFIG, MANIFEST, {
          logger: SILENT,
        }),
      ),
      planned = yield* Effect.promise((): PromiseLike<ReleasePullRequest[]> =>
        loaded.buildPullRequests(),
      ),
      read = yield* Schema.decodeUnknownEffect(Schema.Array(Pull))(planned)

    return read.map((pull) => describe(pull)).toSorted()
  }, Effect.orDie)

/** Release-please's release plan for synthetic commits, made offline. */
export default Object.freeze({ libraryChange, plan })
