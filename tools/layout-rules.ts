import type Snapshot from "./snapshot.ts"
import catalogRules from "./catalog-rules.ts"
import libraryRules from "./library-rules.ts"
import pluginFileRules from "./plugin-file-rules.ts"
import pluginManifestRules from "./plugin-manifest-rules.ts"
import releaseRules from "./release-rules.ts"
import suppressionRules from "./suppression-rules.ts"

/* Every layout problem in `snapshot`, one line each, naming its file. */
const problems = (snapshot: typeof Snapshot.Type): readonly string[] => [
  ...snapshot.plugins.flatMap((folder) => [
    ...pluginFileRules.problems(snapshot, folder),
    ...pluginManifestRules.problems(snapshot, folder),
  ]),
  ...snapshot.libraries.flatMap((folder) =>
    libraryRules.problems(snapshot, folder),
  ),
  ...releaseRules.problems(snapshot),
  ...catalogRules.problems(snapshot),
  ...suppressionRules.problems(snapshot),
]

/** Every rule of the layout check, run over a snapshot of the repository. */
export default Object.freeze({ problems })
