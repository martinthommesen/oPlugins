import { Array as Arr, Order } from "effect"
import type Snapshot from "./snapshot.ts"

type Layout = typeof Snapshot.Type

type Entry = readonly [string, string]

const CODE = /\.[cm]?[jt]sx?$/u,
  /** A hidden file, such as `.DS_Store`, which no bundle imports. */
  HIDDEN = /\/\.[^/]*$/u,
  /*
   * The name of a library in an import, a re-export, or a dynamic import.
   * A type-only import or re-export leaves nothing in the bundle, so it
   * doesn't count.
   */
  IMPORTED =
    /(?<=(?:\b(?:import|export)\s+(?!type\s)(?:[\w$*{},\s]*?\bfrom\s*)?|\bimport\(\s*)["']@oc-lib\/)[\w-]+/gu,
  /** The folders in a plugin that its bundle is built from. */
  PLUGIN_SOURCES = ["src/", "extension/"],
  TEST = /\.test(?:-support)?\.[cm]?[jt]sx?$/u,
  /*
   * The files of `snapshot` under one of `prefixes`, sorted by path, that a
   * bundle can include: every one but tests, test support, and hidden
   * files. Paths sort by code unit, so the order is the same everywhere.
   */
  filesUnder = (
    snapshot: Layout,
    prefixes: readonly string[],
  ): readonly Entry[] =>
    Object.entries(snapshot.files)
      .filter(
        ([file]: Entry) =>
          prefixes.some((prefix) => file.startsWith(prefix)) &&
          !TEST.test(file) &&
          !HIDDEN.test(file),
      )
      .toSorted(([left]: Entry, [right]: Entry) => Order.String(left, right)),
  /* The names of the libraries that the source `text` imports for code. */
  importsIn = (text: string): readonly string[] => text.match(IMPORTED) ?? [],
  /* The libraries that the code among `files` imports, by folder name. */
  librariesIn = (
    snapshot: Layout,
    files: readonly Entry[],
  ): readonly string[] =>
    Arr.dedupe(
      files
        .filter(([file]: Entry) => CODE.test(file))
        .flatMap(([, text]: Entry) => importsIn(text)),
    ).filter((name) => snapshot.libraries.includes(name)),
  /*
   * The files that make up the library in `folder` as a bundle includes it,
   * sorted by path: its `package.json`, which resolves its imports, and
   * every file in its `src/` but tests and test support.
   */
  libraryInputs = (snapshot: Layout, folder: string): readonly Entry[] =>
    filesUnder(snapshot, [
      `libs/${folder}/package.json`,
      `libs/${folder}/src/`,
    ]),
  /* `pending` and every library they import in turn, added to `found`. */
  transitive = (
    snapshot: Layout,
    pending: readonly string[],
    found: readonly string[],
  ): readonly string[] =>
    Arr.match(pending, {
      onEmpty: () => found.toSorted(),
      onNonEmpty: (queue) => {
        const next = Arr.headNonEmpty(queue),
          rest = Arr.tailNonEmpty(queue)

        if (found.includes(next)) {
          return transitive(snapshot, rest, found)
        }

        return transitive(
          snapshot,
          [...rest, ...librariesIn(snapshot, libraryInputs(snapshot, next))],
          [...found, next],
        )
      },
    }),
  /*
   * The libraries bundled into the plugin in `folder`, by folder name and
   * sorted: those its shipped code imports, and those they import in turn.
   * A library that only its tests or scripts use isn't bundled.
   */
  withinBundle = (snapshot: Layout, folder: string): readonly string[] => {
    const shipped = filesUnder(
      snapshot,
      PLUGIN_SOURCES.map((source) => `packages/${folder}/${source}`),
    )

    return transitive(snapshot, librariesIn(snapshot, shipped), [])
  }

/** Which libraries each plugin's bundle includes, and what each is made of. */
export default Object.freeze({
  bundledInto: withinBundle,
  inputsOf: libraryInputs,
})
