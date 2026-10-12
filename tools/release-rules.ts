import { Array as Arr, Option, Result, Schema } from "effect"
import type Snapshot from "./snapshot.ts"
import layoutFiles from "./layout-files.ts"

const CONFIG = "release-please-config.json",
  MANIFEST = ".release-please-manifest.json",
  /** How release-please releases one package. */
  Release = Schema.Struct({
    component: Schema.optionalKey(Schema.String),
    "package-name": Schema.optionalKey(Schema.String),
  }),
  /** The part of `release-please-config.json` the checks read. */
  ReleaseConfig = Schema.fromJsonString(
    Schema.Struct({ packages: Schema.Record(Schema.String, Release) }),
  ),
  /** `.release-please-manifest.json`: each package's last released version. */
  ReleaseManifest = Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.String),
  ),
  /* The listed packages in `file` are `expected`, no more and no fewer. */
  checkListed = (
    file: string,
    listed: readonly string[],
    expected: readonly string[],
  ): readonly string[] => [
    ...Arr.difference(expected, listed).map((missing) =>
      layoutFiles.at(
        file,
        `It doesn't list the plugin ${missing}. Add it, so release-please releases the plugin.`,
      ),
    ),
    ...Arr.difference(listed, expected).map((extra) =>
      layoutFiles.at(
        file,
        `It lists ${extra}, which isn't a plugin. Remove it.`,
      ),
    ),
  ],
  /* Each plugin's release: its component and package name. */
  checkReleases = (
    config: typeof ReleaseConfig.Type,
    plugins: readonly string[],
  ): readonly string[] =>
    plugins.flatMap((folder) =>
      Option.match(
        Option.fromUndefinedOr(config.packages[`packages/${folder}`]),
        {
          onNone: () => [],
          onSome: (release) => [
            ...layoutFiles.reportIf(
              release.component !== folder,
              CONFIG,
              `packages/${folder} has "component" ${layoutFiles.quotedField(release.component)}. Set it to "${folder}".`,
            ),
            ...layoutFiles.reportIf(
              release["package-name"] !== `@martinthommesen/${folder}`,
              CONFIG,
              `packages/${folder} has "package-name" ${layoutFiles.quotedField(release["package-name"])}. Set it to "@martinthommesen/${folder}".`,
            ),
          ],
        },
      ),
    ),
  /* Every problem in the release-please config and manifest. */
  problems = (snapshot: typeof Snapshot.Type): readonly string[] => {
    const expected = snapshot.plugins.map((folder) => `packages/${folder}`)

    return [
      ...Result.match(
        layoutFiles.decodedAt(
          snapshot.files,
          CONFIG,
          Schema.decodeResult(ReleaseConfig),
        ),
        {
          onFailure: (problem) => [problem],
          onSuccess: (config) => [
            ...checkListed(CONFIG, Object.keys(config.packages), expected),
            ...checkReleases(config, snapshot.plugins),
          ],
        },
      ),
      ...Result.match(
        layoutFiles.decodedAt(
          snapshot.files,
          MANIFEST,
          Schema.decodeResult(ReleaseManifest),
        ),
        {
          onFailure: (problem) => [problem],
          onSuccess: (manifest) =>
            checkListed(MANIFEST, Object.keys(manifest), expected),
        },
      ),
    ]
  }

/** The checks that release-please releases exactly the plugins. */
export default Object.freeze({ problems })
