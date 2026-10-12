import { Crypto, Effect, Option, pipe } from "effect"
import { Hex } from "effect/encoding"
import type Snapshot from "./snapshot.ts"
import bundledLibraries from "./bundled-libraries.ts"
import layoutFiles from "./layout-files.ts"

type Layout = typeof Snapshot.Type

/** One plugin's fingerprint file, as the libraries bundled into it make it. */
interface Fingerprint {
  /** The file's path from the root. */
  readonly file: string
  readonly plugin: string
  readonly text: string
}

const COMMAND = "pnpm run fingerprints",
  /** The fingerprint file's name in each plugin's folder. */
  FILE_NAME = "bundled-libraries.txt",
  /*
   * The SHA-256 digest of the library in `folder`, as lowercase hex: its
   * inputs' paths, from the library's folder, and texts, in path order.
   * A failing digest is a broken platform rather than a problem to report.
   */
  digestOf = Effect.fn("Fingerprints.digestOf")(function* digestOf(
    snapshot: Layout,
    folder: string,
  ) {
    const hasher = yield* Crypto.Crypto,
      prefix = `libs/${folder}/`,
      source = bundledLibraries
        .inputsOf(snapshot, folder)
        .map(
          ([file, text]: readonly [string, string]) =>
            `${file.slice(prefix.length)}\n${String(text.length)}\n${text}\n`,
        )
        .join("")

    return Hex.encode(
      yield* hasher.digest("SHA-256", new TextEncoder().encode(source)),
    )
  }, Effect.orDie),
  /* The path, from the root, of the plugin in `folder`'s fingerprint file. */
  fileOf = (folder: string): string => `packages/${folder}/${FILE_NAME}`,
  /* The fingerprint file of the plugin in `folder`, as it should read. */
  fingerprintOf = Effect.fn("Fingerprints.fingerprintOf")(
    function* fingerprintOf(snapshot: Layout, folder: string) {
      const lines = yield* Effect.forEach(
        bundledLibraries.bundledInto(snapshot, folder),
        (library) =>
          digestOf(snapshot, library).pipe(
            Effect.map((digest) => `${library} ${digest}`),
          ),
      )

      return {
        file: fileOf(folder),
        plugin: folder,
        text: [
          `# The libraries bundled into ${folder}, each with a SHA-256 digest of`,
          "# its source and build inputs. A change to this file is a change to",
          `# ${folder}, so release-please releases it for a fix or feat commit.`,
          `# \`${COMMAND}\` writes it; don't edit it by hand.`,
          ...lines,
          "",
        ].join("\n"),
      } satisfies Fingerprint
    },
  ),
  /* Every plugin's fingerprint file, as the snapshot's libraries make it. */
  fingerprintsOf = (
    snapshot: Layout,
  ): Effect.Effect<readonly Fingerprint[], never, Crypto.Crypto> =>
    pipe(
      snapshot.plugins,
      Effect.forEach((folder) => fingerprintOf(snapshot, folder)),
    ),
  /* The problem with `fingerprint`'s file in the snapshot, if any. */
  problemWith = (
    snapshot: Layout,
    fingerprint: Fingerprint,
  ): readonly string[] =>
    Option.match(layoutFiles.textOf(snapshot.files, fingerprint.file), {
      onNone: () => [
        layoutFiles.at(
          fingerprint.file,
          `The fingerprint of the libraries bundled into ${fingerprint.plugin} is missing. Run ${COMMAND}, then commit it, so a change to a library bundled into ${fingerprint.plugin} releases ${fingerprint.plugin}.`,
        ),
      ],
      onSome: (text) =>
        layoutFiles.reportIf(
          text !== fingerprint.text,
          fingerprint.file,
          `The fingerprint of the libraries bundled into ${fingerprint.plugin} is stale. Run ${COMMAND}, then commit it with the library change, so release-please releases ${fingerprint.plugin}.`,
        ),
    }),
  /* Every plugin whose fingerprint file is missing or stale, one line each. */
  problems = (
    snapshot: Layout,
  ): Effect.Effect<readonly string[], never, Crypto.Crypto> =>
    fingerprintsOf(snapshot).pipe(
      Effect.map((fingerprints) =>
        fingerprints.flatMap((fingerprint) =>
          problemWith(snapshot, fingerprint),
        ),
      ),
    )

/**
 * Each plugin's fingerprint of the libraries bundled into it, which puts a
 * library change in the folder of every plugin it's bundled into.
 */
export default Object.freeze({
  FILE_NAME,
  expected: fingerprintsOf,
  problems,
})
