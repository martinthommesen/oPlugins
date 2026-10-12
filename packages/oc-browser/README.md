# oc-browser

oc-browser is an OpenCode v2 plugin and Chrome extension that will let OpenCode
drive your browser.

This is a scaffold, and no browser control exists yet. The agreed design is in
[`docs/design.md`](docs/design.md).

## Install

You need:

- OpenCode 2.0.27 or newer
- Node 26 and pnpm 12, to build oc-browser from a checkout
- Google Chrome 120 or newer

oc-browser isn't published to npm. Install it from an oc-plugins checkout:

1. Build it:

   ```sh
   pnpm install
   pnpm --filter @martinthommesen/oc-browser run build
   ```

2. Add the built plugin to the plural `plugins` field in `opencode.jsonc`, and
   restart OpenCode:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/path/to/oc-plugins/packages/oc-browser/dist"],
   }
   ```

3. Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**,
   and select `packages/oc-browser/dist/extension`.

After you pull changes, build again. OpenCode loads the new build on its next
start. To reload the extension, click the reload button on its card in
`chrome://extensions`.

## Configure

oc-browser has no options yet. Any option set in the object form of its
`plugins` entry is unknown, and an unknown option stops the plugin from loading.

## Environment variables

oc-browser reads no environment variables. The host test reads two, as
[Verify host compatibility](#verify-host-compatibility) describes.

## How it works

- The server plugin checks its options and logs `plugin_started`.
- The CLI plugin adds a palette command, **Show oc-browser status**, which shows
  the toast "oc-browser is loaded".
- The extension's service worker logs `service_worker_started` to its own
  console.

The server plugin's log records go to OpenCode's log, not to a file of their
own. Records at info level and above carry only metadata, such as event names
and the project ID.

## Limitations

oc-browser can't control the browser yet. [`docs/design.md`](docs/design.md)
describes what v1 will do.

## Troubleshooting

- If OpenCode doesn't load oc-browser, look in OpenCode's log for an error that
  names an option and says that oc-browser has no options. Remove the option
  from oc-browser's `plugins` entry, and restart OpenCode.
- If Chrome can't load the extension, check that you selected the built folder,
  `dist/extension`, not `extension`.

## Development

From the repository root, `pnpm run check` runs every check on every package,
oc-browser included. In `packages/oc-browser`:

```sh
pnpm run typecheck   # the plugin project, then the extension project
pnpm run lint:effect # Effect diagnostics for both projects
pnpm test
pnpm run build       # dist/ for the plugin, dist/extension/ for Chrome
```

Read the root `AGENTS.md` and `LINTING.md`, then this package's `AGENTS.md`,
before you write code. The lint policy forces an unusual but uniform module
shape.

### Verify host compatibility

Run `pnpm run test:host` to test the packed plugin against OpenCode 2.0.27. The
test installs the pinned CLI and the packed plugin in a temporary directory,
with their own config, data, cache, and state directories, and checks that the
host starts the plugin. It downloads OpenCode, so it needs network access. CI
runs it on Linux and macOS.

To check another v2 host version:

```sh
OC_BROWSER_HEADLESS_HOST_VERSION=2.0.27 pnpm run test:host
```

Set it to `oldest` to check the oldest version oc-browser supports, which its
`package.json` records as `engines.opencode`.

Set `HEADLESS_KEEP=1` to keep the sandbox afterwards.

## License

[MIT](LICENSE)
