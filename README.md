# oc-plugins

OpenCode v2 plugins, one package each.

## Development

Requires Node 26 and pnpm 12.

```sh
pnpm install
pnpm run check
```

`check` runs lint, format check, typecheck, Effect diagnostics, and tests for
every package, then builds and packs every plugin and runs publint, knip,
sherif, and the layout check. `pnpm run secrets` scans for secrets with gitleaks
(`brew install gitleaks`). See `AGENTS.md` for the policy behind them.

## Plugins

| Plugin     | npm name                      | Published |
| ---------- | ----------------------------- | --------- |
| oc-advisor | `@martinthommesen/oc-advisor` | Not yet   |
| oc-auth    | `@martinthommesen/oc-auth`    | Not yet   |
| oc-auto    | `@martinthommesen/oc-auto`    | Not yet   |
| oc-browser | `@martinthommesen/oc-browser` | Not yet   |

Each plugin lives in `packages/<plugin name>`.

## Releasing

release-please runs in manifest mode (`release-please-config.json`,
`.release-please-manifest.json`) and releases each plugin on its own, with its
own pull request and tagged `<plugin name>-v<version>`. While a plugin is below
1.0, a breaking change bumps the minor version.

### Library changes

A library ships only inside the plugins it's bundled into, and release-please
releases a plugin only for a commit that changes a file in the plugin's folder.
So each plugin commits `bundled-libraries.txt`, a fingerprint of the libraries
its published code imports, directly or through another library: one digest per
library of its `package.json` and the code in its `src/`. Tests, test support,
type-only imports, and libraries that only tests or scripts use don't count.
[ADR 0004](docs/adr/0004-library-changes-release-through-plugin-fingerprints.md)
records why.

- The pre-commit hook writes the fingerprints from the staged files and stages
  them, and nothing else. A commit that changes a library therefore changes the
  fingerprint of every plugin it's bundled into, and an edit you haven't staged
  doesn't reach a fingerprint. Without the hook, run `pnpm run fingerprints` and
  commit the files it updates with the library change.
- The fingerprints decide which plugins a library change reaches, and the commit
  type decides whether they release. A library `fix:` releases a patch of each
  plugin it's bundled into, a `feat:` a minor version, and a breaking change a
  major version. A `chore:` or `refactor:` releases nothing.
- `pnpm run check` fails when a fingerprint is stale, naming the plugin. If a
  library change reached `main` with stale fingerprints, run
  `pnpm run fingerprints` and commit the result with the type and breaking
  change marker the library change needed, such as
  `fix(log-redaction): redact cookies`. A `chore:` repair releases nothing.
- On each push to `main`, `release.yml` runs the layout check, which checks the
  fingerprints, on the commit that triggered it, and release-please runs only
  when it passes. release-please reads the head of `main`, so when `main` has
  moved past the checked commit, the run skips release-please and leaves the
  release to the run for the newer push.
- `tools/package.json` pins release-please at the version the release action
  bundles, and the tools' tests plan releases with it offline, against a fake
  GitHub. The release-please job in `release.yml` records the action's commit
  and that version in its env, and the layout check fails when the steps, the
  record, and the pin disagree. To update the action, record its new commit and
  the release-please version in its `package-lock.json`, use the commit in every
  step, and pin that version in `tools/package.json`.

### Publishing

Publishing isn't set up yet. `release.yml` publishes with npm trusted
publishing, which needs no token, but npm lets you configure it only for a
package that already exists. To set up publishing for a plugin:

1. Publish its first version, 0.1.0, by hand, and tag it `<plugin name>-v0.1.0`.
2. Shortly before its next release, add the trusted publisher on npmjs.com: user
   `martinthommesen`, repository `oc-plugins`, workflow `release.yml`. A new
   trusted publisher expires unless a publish uses it within 48 hours.
3. Set the plugin's repository variable, such as `OC_AUTH_NPM_PUBLISH`, to
   `true`. Until you do, `release.yml` skips the plugin's publish step.
