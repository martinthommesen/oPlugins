import { Equal, Option, Predicate, Record as Rec, Result } from "effect"
import type PackageManifest from "./package-manifest.ts"
import type Snapshot from "./snapshot.ts"
import layoutFiles from "./layout-files.ts"

type Manifest = typeof PackageManifest.Type

type Field =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "peerDependencies"

/** One plugin's manifest, and what its checks compare it with. */
interface Plugin {
  /** The path of its `package.json`. */
  readonly file: string
  readonly folder: string
  /** Whether it has a CLI plugin, `src/tui.ts`. */
  readonly hasTui: boolean
  readonly manifest: Manifest
}

/** One dependency a manifest declares, and the field it's in. */
interface Dependency {
  readonly field: Field
  readonly name: string
  readonly version: string
}

const FIELDS: readonly Field[] = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ],
  LIBRARY_SCOPE = "@oc-lib/",
  NONE = Rec.empty<string, string>(),
  OLDEST_HOST = /^>=\d+\.\d+\.\d+$/u,
  RANGE = /^[\^~<>=*\d][^:]*$/u,
  REPOSITORY_URL = "git+https://github.com/martinthommesen/oc-plugins.git",
  SCRIPTS = [
    "build",
    "typecheck",
    "lint:effect",
    "test",
    "test:host",
    "verify:dist",
    "prepublishOnly",
  ],
  SEMVER = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u,
  /* The author's name, from either form `package.json` allows. */
  authorName = (author: string | { readonly name: string }): string => {
    if (Predicate.isString(author)) {
      return author
    }

    return author.name
  },
  /* What a plugin exports, and the hosts it supports. */
  checkEntries = (plugin: Plugin): readonly string[] => {
    const engines = plugin.manifest.engines ?? NONE,
      exported = plugin.manifest.exports ?? NONE,
      oldest = Rec.get(engines, "opencode"),
      tui = Rec.get(exported, "./tui")

    return [
      ...layoutFiles.reportIf(
        !Option.contains(Rec.get(exported, "."), "./dist/index.js"),
        plugin.file,
        `"exports" lacks ".": "./dist/index.js". Add it.`,
      ),
      ...layoutFiles.reportIf(
        plugin.hasTui && !Option.contains(tui, "./dist/tui.js"),
        plugin.file,
        `"exports" lacks "./tui": "./dist/tui.js", but src/tui.ts exists. Add it.`,
      ),
      ...layoutFiles.reportIf(
        !plugin.hasTui && Option.isSome(tui),
        plugin.file,
        `"exports" has "./tui", but src/tui.ts doesn't exist. Remove it.`,
      ),
      ...layoutFiles.reportIf(
        Rec.has(engines, "node"),
        plugin.file,
        `"engines.node" is set, but the host decides the Node version. Remove it.`,
      ),
      ...layoutFiles.reportIf(
        !Option.exists(oldest, (range) => OLDEST_HOST.test(range)),
        plugin.file,
        `"engines.opencode" is ${layoutFiles.quoted(oldest)}. Set it to the oldest supported OpenCode version, such as ">=2.0.26".`,
      ),
    ]
  },
  /* How a plugin is named, licensed, and published. */
  checkIdentity = (plugin: Plugin): readonly string[] => {
    const { manifest } = plugin,
      npmName = `@martinthommesen/${plugin.folder}`

    return [
      ...layoutFiles.reportIf(
        manifest.name !== npmName,
        plugin.file,
        `"name" is ${layoutFiles.quotedField(manifest.name)}. Set it to "${npmName}".`,
      ),
      ...layoutFiles.reportIf(
        !SEMVER.test(manifest.version ?? ""),
        plugin.file,
        `"version" is ${layoutFiles.quotedField(manifest.version)}, which isn't a semver version. Set it to one, such as "0.1.0".`,
      ),
      ...layoutFiles.reportIf(
        manifest.license !== "MIT",
        plugin.file,
        `"license" is ${layoutFiles.quotedField(manifest.license)}. Set it to "MIT".`,
      ),
      ...layoutFiles.reportIf(
        !Option.exists(
          Option.fromUndefinedOr(manifest.author),
          (author) => authorName(author).trim() !== "",
        ),
        plugin.file,
        `"author" is missing. Set it to the maintainer.`,
      ),
    ]
  },
  /* A library dependency: bundled, so a devDependency from the workspace. */
  checkLibrary = (file: string, dependency: Dependency): readonly string[] => {
    if (dependency.field !== "devDependencies") {
      return [
        layoutFiles.at(
          file,
          `"${dependency.name}" is in "${dependency.field}". Move it to "devDependencies", because the plugin's bundle includes the library.`,
        ),
      ]
    }

    return layoutFiles.reportIf(
      dependency.version !== "workspace:*",
      file,
      `devDependencies "${dependency.name}" is "${dependency.version}". Set it to "workspace:*".`,
    )
  },
  /* How a plugin's package is shaped and found. */
  checkPackage = (plugin: Plugin): readonly string[] => {
    const { manifest } = plugin,
      repository = {
        directory: `packages/${plugin.folder}`,
        type: "git",
        url: REPOSITORY_URL,
      }

    return [
      ...layoutFiles.reportIf(
        manifest.type !== "module",
        plugin.file,
        `"type" is ${layoutFiles.quotedField(manifest.type)}. Set it to "module".`,
      ),
      ...layoutFiles.reportIf(
        !Equal.equals(manifest.files, ["dist"]),
        plugin.file,
        `"files" isn't ["dist"]. Set it to ["dist"], so the package holds only the bundle.`,
      ),
      ...layoutFiles.reportIf(
        Object.hasOwn(manifest, "private"),
        plugin.file,
        `"private" is set, but a plugin is published. Remove it.`,
      ),
      ...layoutFiles.reportIf(
        !Equal.equals(manifest.repository, repository),
        plugin.file,
        `"repository" doesn't point at ${repository.directory} in oc-plugins. Set it to { "type": "git", "url": "${REPOSITORY_URL}", "directory": "${repository.directory}" }.`,
      ),
      ...layoutFiles.reportIf(
        !(manifest.keywords ?? []).includes("opencode"),
        plugin.file,
        `"keywords" lacks "opencode". Add it.`,
      ),
    ]
  },
  /* The scripts every plugin runs. */
  checkScripts = (plugin: Plugin): readonly string[] => {
    const scripts = plugin.manifest.scripts ?? NONE

    return SCRIPTS.flatMap((script) =>
      layoutFiles.reportIf(
        !Rec.has(scripts, script),
        plugin.file,
        `The "${script}" script is missing. Add it.`,
      ),
    )
  },
  /*
   * A dependency's version: `workspace:*` for a library, a range for a peer,
   * and `catalog:` for the rest.
   */
  checkVersion = (file: string, dependency: Dependency): readonly string[] => {
    if (dependency.name.startsWith(LIBRARY_SCOPE)) {
      return checkLibrary(file, dependency)
    }

    if (dependency.field === "peerDependencies") {
      return layoutFiles.reportIf(
        !RANGE.test(dependency.version),
        file,
        `peerDependencies "${dependency.name}" is "${dependency.version}". Set it to a version range, such as ">=1.0.0".`,
      )
    }

    return layoutFiles.reportIf(
      dependency.version !== "catalog:",
      file,
      `${dependency.field} "${dependency.name}" is "${dependency.version}". Set it to "catalog:", and pin the version in the catalog in pnpm-workspace.yaml.`,
    )
  },
  /* Every dependency in every dependency field. */
  checkVersions = (plugin: Plugin): readonly string[] =>
    FIELDS.flatMap((field) =>
      Object.entries(plugin.manifest[field] ?? NONE).flatMap(
        ([name, version]: readonly [string, string]) =>
          checkVersion(plugin.file, { field, name, version }),
      ),
    ),
  /* Every problem in the `package.json` of the plugin in `folder`. */
  problems = (
    snapshot: typeof Snapshot.Type,
    folder: string,
  ): readonly string[] => {
    const file = `packages/${folder}/package.json`,
      hasTui = Option.isSome(
        layoutFiles.textOf(snapshot.files, `packages/${folder}/src/tui.ts`),
      )

    return Result.match(layoutFiles.manifestAt(snapshot.files, file), {
      onFailure: (problem) => [problem],
      onSuccess: (manifest) => {
        const plugin = { file, folder, hasTui, manifest }

        return [
          ...checkIdentity(plugin),
          ...checkPackage(plugin),
          ...checkEntries(plugin),
          ...checkScripts(plugin),
          ...checkVersions(plugin),
        ]
      },
    })
  }

/** The checks of a plugin's `package.json`. */
export default Object.freeze({ problems })
