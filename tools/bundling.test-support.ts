import { Record as Rec } from "effect"
import type Snapshot from "./snapshot.ts"

type Layout = typeof Snapshot.Type

/* A library's `package.json`, named for `folder`. */
const manifest = (folder: string): string =>
    `${JSON.stringify({ name: `@oc-lib/${folder}`, private: true })}\n`,
  /*
   * Three plugins and five libraries. oc-one's code imports shared, which
   * imports deep. oc-two's extension re-exports shared, and its code loads
   * lazy dynamically. oc-three imports typed for types only. testkit is
   * only in tests, test support, and scripts.
   */
  repository: Layout = {
    files: {
      "libs/deep/package.json": manifest("deep"),
      "libs/deep/src/deep.ts": "export default 1\n",
      "libs/lazy/package.json": manifest("lazy"),
      "libs/lazy/src/lazy.ts": "export default 2\n",
      "libs/shared/AGENTS.md": "# shared\n",
      "libs/shared/package.json": manifest("shared"),
      "libs/shared/src/.DS_Store": "Finder\n",
      "libs/shared/src/shared.test.ts":
        'import testkit from "@oc-lib/testkit/testkit.ts"\n',
      "libs/shared/src/shared.ts":
        'import deep from "@oc-lib/deep/deep.ts"\n\nexport default deep\n',
      "libs/testkit/package.json": manifest("testkit"),
      "libs/testkit/src/testkit.ts": "export default 3\n",
      "libs/typed/package.json": manifest("typed"),
      "libs/typed/src/typed.ts": "export type Kind = string\n",
      "packages/oc-one/scripts/test-host.ts":
        'import testkit from "@oc-lib/testkit/testkit.ts"\n',
      "packages/oc-one/src/index.test.ts":
        'import testkit from "@oc-lib/testkit/testkit.ts"\n',
      "packages/oc-one/src/index.ts":
        'import shared from "@oc-lib/shared/shared.ts"\n\nexport default shared\n',
      "packages/oc-three/src/fake.test-support.ts":
        'import shared from "@oc-lib/shared/shared.ts"\n',
      "packages/oc-three/src/index.ts": [
        'import type { Kind } from "@oc-lib/typed/typed.ts"',
        'export type { Kind as Sort } from "@oc-lib/typed/typed.ts"',
        "",
      ].join("\n"),
      "packages/oc-two/extension/worker.ts":
        'export { default } from "@oc-lib/shared/shared.ts"\n',
      "packages/oc-two/src/index.ts":
        'const loaded = import("@oc-lib/lazy/lazy.ts")\n',
    },
    libraries: ["deep", "lazy", "shared", "testkit", "typed"],
    plugins: ["oc-one", "oc-three", "oc-two"],
  },
  /* The layout, with `file` holding `text`. */
  withFile = (layout: Layout, file: string, text: string): Layout => ({
    files: Rec.set(layout.files, file, text),
    libraries: layout.libraries,
    plugins: layout.plugins,
  })

/** Plugins and libraries that bundle each other in every way there is. */
export default Object.freeze({ LAYOUT: repository, withFile })
