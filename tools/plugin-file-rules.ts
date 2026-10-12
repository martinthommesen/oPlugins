import { Option } from "effect"
import type Snapshot from "./snapshot.ts"
import layoutFiles from "./layout-files.ts"
import sourceText from "./source-text.ts"

type Files = (typeof Snapshot.Type)["files"]

const MIT = "MIT License",
  PLUGIN_NAME = /^oc-[a-z]+$/u,
  PREFIX = "oc-",
  REQUIRED = [
    "README.md",
    "AGENTS.md",
    "LICENSE",
    "tsconfig.json",
    "tsdown.config.ts",
    "vitest.config.ts",
    "src/index.ts",
    "scripts/test-host.ts",
  ],
  SCANNED = ["src/", "scripts/"],
  SOURCE = /\.[cm]?[jt]sx?$/u,
  VARIABLE = /^OC_[A-Z0-9_]+$/u,
  /* Every required file the plugin in `folder` lacks. */
  checkFiles = (files: Files, folder: string): readonly string[] =>
    REQUIRED.flatMap((name) => {
      const file = `packages/${folder}/${name}`

      return layoutFiles.reportIf(
        Option.isNone(layoutFiles.textOf(files, file)),
        file,
        "The file is missing. Add it.",
      )
    }),
  /* The folder is the plugin name, `oc-<word>`. */
  checkFolder = (folder: string): readonly string[] =>
    layoutFiles.reportIf(
      !PLUGIN_NAME.test(folder),
      `packages/${folder}`,
      "The folder name doesn't match ^oc-[a-z]+$. Rename the plugin to oc-<word>, as ADR 0003 says.",
    ),
  /* The entry `file`, when present, declares the plugin ID `id`. */
  checkId = (files: Files, file: string, id: string): readonly string[] =>
    Option.match(layoutFiles.textOf(files, file), {
      onNone: () => [],
      onSome: (text) =>
        layoutFiles.reportIf(
          !text.includes(`"${id}"`),
          file,
          `The plugin ID "${id}" is missing. Set the plugin's id to "${id}".`,
        ),
    }),
  /* The server and CLI plugins carry the IDs the plugin name gives them. */
  checkIds = (files: Files, folder: string): readonly string[] => [
    ...checkId(
      files,
      `packages/${folder}/src/index.ts`,
      `martinthommesen.${folder}`,
    ),
    ...checkId(
      files,
      `packages/${folder}/src/tui.ts`,
      `martinthommesen.${folder}.cli`,
    ),
  ],
  /* The plugin's license is MIT. */
  checkLicense = (files: Files, folder: string): readonly string[] => {
    const file = `packages/${folder}/LICENSE`

    return Option.match(layoutFiles.textOf(files, file), {
      onNone: () => [],
      onSome: (text) =>
        layoutFiles.reportIf(
          !text.startsWith(MIT),
          file,
          "The license isn't the MIT License. Use the MIT License text, as every plugin does.",
        ),
    })
  },
  /* Every `OC_` variable named in `text` starts with `prefix`. */
  checkLiterals = (
    file: string,
    text: string,
    prefix: string,
  ): readonly string[] =>
    sourceText.stringLiterals(text).flatMap((literal) => {
      if (!VARIABLE.test(literal.text) || literal.text.startsWith(prefix)) {
        return []
      }

      return [
        layoutFiles.atLine(
          file,
          literal.line,
          `"${literal.text}" doesn't start with ${prefix}. Rename it so it starts with the plugin's prefix, ${prefix}.`,
        ),
      ]
    }),
  /*
   * Every `OC_` variable in the plugin's `src/` and `scripts/` starts with
   * the plugin's own prefix: `OC_AUTH_` for oc-auth.
   */
  checkVariables = (files: Files, folder: string): readonly string[] => {
    const prefix = `OC_${folder.slice(PREFIX.length).toUpperCase().replaceAll("-", "_")}_`,
      roots = SCANNED.map((directory) => `packages/${folder}/${directory}`)

    return Object.entries(files).flatMap(
      ([file, text]: readonly [string, string]) => {
        if (
          !SOURCE.test(file) ||
          !roots.some((root) => file.startsWith(root))
        ) {
          return []
        }

        return checkLiterals(file, text, prefix)
      },
    )
  },
  /* Every problem in the files of the plugin in `folder`. */
  problems = (
    snapshot: typeof Snapshot.Type,
    folder: string,
  ): readonly string[] => [
    ...checkFolder(folder),
    ...checkFiles(snapshot.files, folder),
    ...checkLicense(snapshot.files, folder),
    ...checkIds(snapshot.files, folder),
    ...checkVariables(snapshot.files, folder),
  ]

/** The checks of a plugin's files: which exist, and what they name. */
export default Object.freeze({ problems })
