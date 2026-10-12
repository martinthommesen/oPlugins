import {
  Array as Arr,
  Effect,
  Function as Fn,
  Option,
  Record as Rec,
  Schema,
} from "effect"
import { Base64 } from "effect/encoding"
import type { Commit } from "release-please"
import type { Scm } from "release-please/build/src/scm"

/** One commit on `main`, newest first, as release-please reads it. */
interface Change {
  readonly files: readonly string[]
  readonly message: string
  readonly sha: string
}

/** What the fake source-control backend holds. */
interface Backend {
  /** The commits on `main` since the last release, newest first. */
  readonly changes: readonly Change[]
  /** The text of each file on `main`, by its path from the root. */
  readonly files: Readonly<Record<string, string>>
  /** The last release's commit, which every `tags` points at. */
  readonly released: string
  /** The last release's tags, such as `oc-auth-v0.1.0`. */
  readonly tags: readonly string[]
}

type Contents = Awaited<ReturnType<Scm["getFileContents"]>>

const Json = Schema.fromJsonString(Schema.Any),
  /** A search for files, which finds none. */
  NOTHING = Fn.flow(() => Effect.succeed([]), Effect.runPromise),
  OWNER = "martinthommesen",
  /* A failure for `operation`, which the offline backend never performs. */
  absent = (operation: string): Effect.Effect<never> =>
    Effect.die(
      `The offline release test has no GitHub, so it can't ${operation}.`,
    ),
  /* The text of `path` in `backend`, or a defect when there's no such file. */
  bodyOf = (backend: Backend, path: string): Effect.Effect<string> =>
    Option.match(Rec.get(backend.files, path), {
      onNone: () => absent(`read ${path}`),
      onSome: (text) => Effect.succeed(text),
    }),
  /* `path` in `backend`, as release-please reads a file's contents. */
  contentsAt = (backend: Backend, path: string): Effect.Effect<Contents> =>
    bodyOf(backend, path).pipe(
      Effect.map((text) => ({
        content: Base64.encode(text),
        mode: "100644",
        parsedContent: text,
        sha: path,
      })),
    ),
  /* An async generator that yields `values`, in order, then finishes. */
  generatorOf = <Value>(
    values: readonly Value[],
  ): AsyncGenerator<Value, void, void> => {
    const cursor = values.values(),
      generator: AsyncGenerator<Value, void, void> = {
        [Symbol.asyncDispose]: Fn.flow(() => Effect.void, Effect.runPromise),
        [Symbol.asyncIterator]: () => generator,
        next: Fn.flow(
          () => Effect.sync(() => cursor.next()),
          Effect.runPromise,
        ),
        return: Fn.flow(
          () => Effect.sync(() => Arr.empty<Value>().values().next()),
          Effect.runPromise,
        ),
        throw: Fn.flow(
          (cause: unknown) => Effect.die(cause),
          Effect.runPromise,
        ),
      }

    return generator
  },
  /* The commits of `backend`, newest first, then its release commit. */
  historyOf = (backend: Backend): readonly Commit[] => [
    ...backend.changes.map((change) => ({
      files: [...change.files],
      message: change.message,
      sha: change.sha,
    })),
    {
      files: [],
      message: "chore: release main",
      pullRequest: {
        baseBranchName: "main",
        body: "",
        files: [],
        headBranchName: "release-please--branches--main",
        labels: ["autorelease: tagged"],
        number: 1,
        title: "chore: release main",
      },
      sha: backend.released,
    },
  ],
  /* A failing operation of the backend, named for its failure. */
  refuse = (operation: string): (() => Promise<never>) =>
    Fn.flow(() => absent(operation), Effect.runPromise),
  /*
   * A source-control backend for release-please that holds `backend` and
   * reaches no network. It reads files, commits, and releases; any write,
   * such as opening a pull request or creating a release, fails the test.
   */
  scmOf = (backend: Backend): Scm => ({
    addIssueLabels: refuse("label an issue"),
    buildChangeSet: refuse("build a change set"),
    commentOnIssue: refuse("comment on an issue"),
    commitsSince: refuse("list commits"),
    createFileOnNewBranch: refuse("create a branch"),
    createPullRequest: refuse("open a pull request"),
    createRelease: refuse("create a release"),
    findFilesByExtension: NOTHING,
    findFilesByExtensionAndRef: NOTHING,
    findFilesByFilename: NOTHING,
    findFilesByFilenameAndRef: NOTHING,
    findFilesByGlob: NOTHING,
    findFilesByGlobAndRef: NOTHING,
    generateReleaseNotes: refuse("generate release notes"),
    getFileContents: Fn.flow(
      (path: string) => contentsAt(backend, path),
      Effect.runPromise,
    ),
    getFileContentsOnBranch: Fn.flow(
      (path: string) => contentsAt(backend, path),
      Effect.runPromise,
    ),
    getFileJson: Fn.flow(
      (path: string) =>
        bodyOf(backend, path).pipe(
          Effect.flatMap((text) => Schema.decodeEffect(Json)(text)),
          Effect.orDie,
        ),
      Effect.runPromise,
    ),
    getPullRequest: refuse("read a pull request"),
    mergeCommitIterator: () => generatorOf(historyOf(backend)),
    pullRequestIterator: () => generatorOf([]),
    releaseIterator: () =>
      generatorOf(
        backend.tags.map((tagName, id) => ({
          id,
          sha: backend.released,
          tagName,
          url: `https://github.com/${OWNER}/oc-plugins/releases/tag/${tagName}`,
        })),
      ),
    removeIssueLabels: refuse("unlabel an issue"),
    repository: { defaultBranch: "main", owner: OWNER, repo: "oc-plugins" },
    tagIterator: () => generatorOf([]),
    updatePullRequest: refuse("update a pull request"),
  })

/** A source-control backend for release-please that works offline. */
export default Object.freeze({ fakeScm: scmOf })
