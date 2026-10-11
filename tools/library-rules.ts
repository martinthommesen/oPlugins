import { Option, Record as Rec, Result } from "effect"
import type PackageManifest from "./package-manifest.ts"
import type Snapshot from "./snapshot.ts"
import layoutFiles from "./layout-files.ts"

const NONE = Rec.empty<string, string>(),
  PLUGIN_PREFIX = "oc-",
  SCRIPTS = ["typecheck", "lint:effect", "test"],
  /* The library's folder name isn't a plugin name. */
  checkFolder = (folder: string): readonly string[] =>
    layoutFiles.reportIf(
      folder.startsWith(PLUGIN_PREFIX),
      `libs/${folder}`,
      `The folder name starts with "${PLUGIN_PREFIX}", which only plugin names do. Rename the library.`,
    ),
  /* The library's `package.json`: its name, privacy, and scripts. */
  checkManifest = (
    manifest: typeof PackageManifest.Type,
    folder: string,
  ): readonly string[] => {
    const file = `libs/${folder}/package.json`,
      name = `@oc-lib/${folder}`,
      scripts = manifest.scripts ?? NONE

    return [
      ...layoutFiles.reportIf(
        manifest.name !== name,
        file,
        `"name" is ${layoutFiles.quotedField(manifest.name)}. Set it to "${name}".`,
      ),
      ...layoutFiles.reportIf(
        manifest.private !== true,
        file,
        `"private" isn't true, but a library is never published. Set it to true.`,
      ),
      ...SCRIPTS.flatMap((script) =>
        layoutFiles.reportIf(
          !Rec.has(scripts, script),
          file,
          `The "${script}" script is missing. Add it.`,
        ),
      ),
    ]
  },
  /* Every problem in the library in `folder`. */
  problems = (
    snapshot: typeof Snapshot.Type,
    folder: string,
  ): readonly string[] => {
    const agents = `libs/${folder}/AGENTS.md`,
      manifest = layoutFiles.manifestAt(
        snapshot.files,
        `libs/${folder}/package.json`,
      )

    return [
      ...checkFolder(folder),
      ...layoutFiles.reportIf(
        Option.isNone(layoutFiles.textOf(snapshot.files, agents)),
        agents,
        "The file is missing. Add it, to tell agents what the library does and how plugins use it.",
      ),
      ...Result.match(manifest, {
        onFailure: (problem) => [problem],
        onSuccess: (decoded) => checkManifest(decoded, folder),
      }),
    ]
  }

/** The checks of a library: its folder, `package.json`, and `AGENTS.md`. */
export default Object.freeze({ problems })
