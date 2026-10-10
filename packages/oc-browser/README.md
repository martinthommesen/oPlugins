# oc-browser

oc-browser is an OpenCode v2 plugin and Chrome extension that will let
OpenCode drive your browser.

This is a scaffold. The plugin starts and writes to its debug log, the TUI
plugin adds one palette command, and the extension's service worker only
logs that it started. No browser control exists yet. The agreed design is
in [`docs/design.md`](docs/design.md).

## Requirements

- OpenCode 2.0.26
- Node 22.18 or newer and pnpm 11, to lint, build, and test from a checkout
- Google Chrome 120 or newer, or another Chromium-based browser

## Install

oc-browser is not published to npm. Build it from an oc-plugins checkout:

```sh
pnpm install
pnpm --filter @martinthommesen/oc-browser run build
```

Then add the built plugin to the plural `plugins` field in
`opencode.jsonc`, and restart OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/oc-plugins/packages/oc-browser/dist"],
}
```

To load the extension, open `chrome://extensions`, turn on Developer mode,
choose **Load unpacked**, and select `packages/oc-browser/dist/extension`.

After pulling changes, run the build again. OpenCode picks the new
build up on its next start. For the extension, click the reload button on
its card in `chrome://extensions`.

## Environment variables

| Variable        | Purpose                                                                                            | Default          |
| --------------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| `OBROWSE_DEBUG` | `1` for the default debug log, or an absolute log file path. `0`, `false`, `no`, `off` all disable | Disabled         |
| `XDG_DATA_HOME` | Selects the data directory that holds the debug log                                                | `~/.local/share` |

The long-running OpenCode service reads every variable above. Setting or
unsetting one takes effect only after `opencode service restart`.

## Debug log

```sh
export OBROWSE_DEBUG=1
opencode service restart
```

The default file is `~/.local/share/opencode/obrowse-debug.log`, created
readable by its owner only. Values under keys such as `authorization`,
`cookie`, `password`, and `token` are redacted, and so is any string shaped
like a JWT. Structure nested more than four levels deep is replaced with a
placeholder. URLs and page details are not redacted, so review a log before
you share it.

Any value other than `1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off` is
treated as an absolute log file path, and that file is truncated on every
service start. A relative path is refused, and so is any existing file that
is not already one of these logs.

## Development

From the repository root, `pnpm run check` lints, type-checks, and tests
every package, oc-browser included. In `packages/oc-browser`:

```sh
pnpm run typecheck   # the plugin project, then the extension project
pnpm run lint:effect # Effect diagnostics for both projects
pnpm test
pnpm run build       # dist/ for the plugin, dist/extension/ for Chrome
```

Read the root `AGENTS.md` and `LINTING.md`, then this package's
`AGENTS.md`, before writing code: the lint policy forces an unusual but
uniform module shape.

## Verify host compatibility

Run `pnpm run test:host` to test the packed plugin against OpenCode 2.0.26.
The test installs the pinned CLI and the packed plugin in a temporary
directory, with their own config, data, cache, and state directories, and
checks that the host starts the plugin. Package installation may require
network access. CI runs this test on Linux and macOS.

To check another V2 host version:

```sh
OC_BROWSER_HEADLESS_HOST_VERSION=2.0.25 pnpm run test:host
```

Set `HEADLESS_KEEP=1` to keep the sandbox afterwards.

## License

[MIT](LICENSE)
