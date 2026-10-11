import { Array as Arr, Option, Record as Rec, Result, Schema } from "effect"
import type Snapshot from "./snapshot.ts"
import layoutFiles from "./layout-files.ts"
import { parseDocument } from "yaml"

type Files = (typeof Snapshot.Type)["files"]

const EFFECT = "effect",
  EFFECT_SCOPE = "@effect/",
  HOST = "@opencode/plugin",
  /** What the checks read from the installed host package's `package.json`. */
  HostManifest = Schema.fromJsonString(
    Schema.Struct({
      dependencies: Schema.Record(Schema.String, Schema.String),
      version: Schema.String,
    }),
  ),
  WORKSPACE = "pnpm-workspace.yaml",
  /** The catalog in `pnpm-workspace.yaml`. */
  Workspace = Schema.Struct({
    catalog: Schema.Record(Schema.String, Schema.String),
  }),
  asHost = Schema.decodeResult(HostManifest),
  /* Why the checks can't read the catalog: `reason`. */
  asUnreadable = (reason: string): string =>
    `The checks can't read the catalog: ${reason} Correct the file.`,
  asWorkspace = Schema.decodeUnknownResult(Workspace),
  /*
   * The catalog's entries that must equal the host's effect pin: `effect`
   * and every `@effect/*` package.
   */
  catalogEffects = (
    catalog: Readonly<Record<string, string>>,
  ): readonly (readonly [string, string])[] =>
    Object.entries(catalog).filter(
      ([name]: readonly [string, string]) =>
        name === EFFECT || name.startsWith(EFFECT_SCOPE),
    ),
  /* The catalog from the workspace file's YAML `text`, or what's wrong. */
  catalogOf = (
    text: string,
  ): Result.Result<Readonly<Record<string, string>>, string> => {
    const document = parseDocument(text),
      errors = document.errors.map(
        (error: { readonly message: string }) => error.message,
      )

    if (Arr.isReadonlyArrayNonEmpty(errors)) {
      return Result.fail(asUnreadable(errors.join(" ")))
    }

    return asWorkspace(document.toJS()).pipe(
      Result.map((workspace) => workspace.catalog),
      Result.mapError((failure: { readonly message: string }) =>
        asUnreadable(failure.message),
      ),
    )
  },
  /* The catalog's effect entries equal `pin`, the host's effect version. */
  checkEffectPins = (
    catalog: Readonly<Record<string, string>>,
    hostVersion: string,
    pin: string,
  ): readonly string[] =>
    catalogEffects(catalog).flatMap(([name, version]) =>
      layoutFiles.reportIf(
        version !== pin,
        WORKSPACE,
        `The catalog pins "${name}" to "${version}", but ${HOST} ${hostVersion}, the host, depends on effect "${pin}". Set it to "${pin}".`,
      ),
    ),
  /* The installed host at `file` is the catalog's, and pins effect. */
  checkHost = (
    catalog: Readonly<Record<string, string>>,
    file: string,
    text: string,
  ): readonly string[] =>
    Result.match(asHost(text), {
      onFailure: (failure: { readonly message: string }) => [
        layoutFiles.at(
          file,
          `The checks can't read the file: ${failure.message}. Run pnpm install.`,
        ),
      ],
      onSuccess: (host) => {
        const pinned = Rec.get(catalog, HOST)

        if (!Option.contains(pinned, host.version)) {
          return [
            layoutFiles.at(
              file,
              `The installed ${HOST} is "${host.version}", but the catalog pins ${layoutFiles.quoted(pinned)}. Run pnpm install.`,
            ),
          ]
        }

        return Option.match(Rec.get(host.dependencies, EFFECT), {
          onNone: () => [
            layoutFiles.at(
              file,
              `${HOST} doesn't depend on effect, so the checks can't read the host's pin. Pin effect by hand, and update this check.`,
            ),
          ],
          onSome: (pin) => checkEffectPins(catalog, host.version, pin),
        })
      },
    }),
  /*
   * The first plugin's installed `@opencode/plugin`, by its path, or none
   * before `pnpm install`.
   */
  installedHost = (
    files: Files,
    plugins: readonly string[],
  ): Option.Option<readonly [string, string]> =>
    Arr.findFirst(plugins, (folder) => {
      const file = `packages/${folder}/node_modules/${HOST}/package.json`

      return layoutFiles
        .textOf(files, file)
        .pipe(Option.map((text) => [file, text] as const))
    }),
  /*
   * Every problem with the catalog's effect pins: `effect` and every
   * `@effect/*` package equal the effect version the host depends on.
   */
  problems = (snapshot: typeof Snapshot.Type): readonly string[] => {
    const catalog = layoutFiles.textOf(snapshot.files, WORKSPACE).pipe(
      Result.fromOption(() => "The file is missing. Add it."),
      Result.flatMap((text) => catalogOf(text)),
    )

    return Result.match(catalog, {
      onFailure: (problem) => [layoutFiles.at(WORKSPACE, problem)],
      onSuccess: (entries) =>
        Option.match(installedHost(snapshot.files, snapshot.plugins), {
          onNone: () => [
            layoutFiles.at(
              WORKSPACE,
              `No plugin has ${HOST} installed, so the checks can't read the effect version the host pins. Run pnpm install.`,
            ),
          ],
          onSome: ([file, text]) => checkHost(entries, file, text),
        }),
    })
  }

/** The check that the catalog pins effect where the host does. */
export default Object.freeze({ problems })
