# oc-auth

[![CI](https://github.com/martinthommesen/oc-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/martinthommesen/oc-plugins/actions/workflows/ci.yml)

oc-auth is an OpenCode v2 plugin that imports Claude Code subscription credentials into
OpenCode's native Anthropic integration. It does not install a custom model
provider or require another browser login.

## Requirements

- OpenCode 2.0.25 or newer
- Claude Code installed and authenticated by running `claude`

This release targets `@opencode/plugin@2.0.26` and is an Effect plugin: it
runs on the `effect` instance the host provides to plugins. It is tested on
OpenCode 2.0.25 and 2.0.26; on 2.0.24 the host could not load its `effect`
import in our loader test. It uses
`model.transform` and `model.reload`. Rather than match version strings, the
plugin checks for the host capabilities it needs at load and reports any
missing ones. OpenCode v1 is not supported.

## Install

oc-auth is not published to npm yet. Build it from an oc-plugins checkout:

```sh
pnpm install
pnpm --filter @martinthommesen/oc-auth run build
```

Then add the built plugin to the plural `plugins` field in
`opencode.jsonc`, and restart OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/oc-plugins/packages/oc-auth/dist"],
}
```

After pulling changes, run the build again; OpenCode picks the new
build up on its next start.

See the [OpenCode v2 plugin guide](https://opencode.ai/v2/docs/build/plugins)
for package and local-file configuration.

## Connect

1. Start `opencode`.
2. Open `/connect`.
3. Choose **Anthropic**.
4. Choose **Import Claude Code subscription**.
5. Select a Claude Code account when more than one is available.

The import completes automatically and OpenCode stores the resulting
connection. Repeat `/connect` to import additional accounts. OpenCode's
connection UI owns activation and account switching.

The account picker is captured when the OpenCode service loads the plugin.
The import reads the selected account's current credentials. If you add or
remove a Claude Code account later, refresh the picker before reopening
`/connect`:

```sh
opencode service restart
```

`opencode auth login` also remains available in v2, but `/connect` is the
primary TUI flow documented for this plugin.

## Credential sources

On macOS, the plugin discovers `Claude Code-credentials*` entries in Keychain
and labels accounts with their subscription tier and email when available. On
Linux and Windows it reads `~/.claude/.credentials.json`.

macOS falls back to that file only when no Keychain entry holds a usable
credential (an entry with only MCP tokens does not count). If the Keychain is
locked, denies access, or times out, the plugin reports that error instead,
because a silent fallback would hide the cause. A credentials file that exists
but cannot be read is reported the same way rather than as missing.

Set `CLAUDE_CONFIG_DIR` to use a different Claude Code configuration directory:

```sh
export CLAUDE_CONFIG_DIR="$HOME/.claude-work"
```

On Linux and Windows the variable selects the credentials file. On macOS the
Keychain remains the credential source, and the variable only selects the
config directory used for account labels (email lookup) and for the file
fallback when no Keychain entry exists.

OpenCode owns connection persistence. The plugin does not write OpenCode
`auth.json` files or maintain a background synchronization timer.

## Behavior

- Uses OpenCode's native Anthropic provider and model catalog.
- Keeps OpenCode's native API pricing, so the sidebar and prompt footer show
  what subscription traffic would cost at API rates. Anthropic does not bill
  this amount to a subscription. Set the `cost` option to `"zero"` to report
  zero dollar cost instead (see [Options](#options)).
- Adds a **Cache** section to the session sidebar with the prompt cache hit
  and miss rates (see [Prompt cache stats](#prompt-cache-stats)).
- Adds the Claude Code billing identity, supported beta flags, and request
  headers required for subscription traffic, including title, compaction, and
  transient generation requests. The current wire defaults match Claude Code
  2.1.295 and its bundled Anthropic SDK 0.128.0.
- Renames tools in the request body to `mcp_` plus the name with its first
  letter upper-cased (`read_file` becomes `mcp_Read_file`), the prefix Claude
  Code uses, because Anthropic's billing validator rejects other tool names. The response restores OpenCode's own names, so tool calls keep their
  native rendering and behavior. The plugin adds the name mapping to the
  first user message so the model can follow instructions written with
  OpenCode names.
  Deferred tool-search references are renamed consistently as well.
- Lets OpenCode own generic rate-limit and provider retries.
- Refreshes near-expiry credentials through Anthropic's current OAuth endpoint,
  with per-account locking, cooldowns, and guarded source write-back. A
  write-back is confirmed by reading the stored credential back. It does not
  refresh while the credential source cannot be read, because the new tokens
  could not be saved and Claude Code would be signed out.
- Adopts credentials rotated by Claude Code or another process without a
  session restart. It re-reads the source at most every 30 seconds, beside
  the request rather than in front of it, so a rotation applies from the next
  request. A request whose cached token has expired waits for the re-read.
- Performs at most two bounded retries after a 401: one source adoption and one
  direct refresh.

OpenCode's `anthropic` provider catalog supplies the available models,
capabilities, and limits. This package does not maintain a separate model list.
New catalog models therefore need no plugin allowlist update, including Claude
Opus 5.5, Sonnet 5.5, and Haiku 5.5. Availability still
depends on Anthropic granting your account access. Legacy models and dated
snapshots keep their model-specific beta exclusions; custom model aliases use
the model ID sent on the wire.

### Models ahead of OpenCode's catalog

If `/models` does not list a newly released model, add it to OpenCode's native
provider configuration. For example, Mythos 5.1 is not in the OpenCode 2.0.26
catalog yet, but can be configured using the metadata from Claude Code 2.1.295:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "anthropic": {
      "models": {
        "claude-mythos-5-1": {
          "name": "Claude Mythos 5.1",
          "capabilities": {
            "tools": true,
            "input": ["text", "image"],
            "output": ["text"],
          },
          "limit": { "context": 1000000, "output": 128000 },
        },
      },
    },
  },
}
```

Merge this with your existing configuration, restart the service, then select
`anthropic/claude-mythos-5-1`. This only makes the model selectable; it does not
grant account access or guarantee Anthropic accepts subscription requests for it.
Other new model IDs can use the same native configuration mechanism with their
own documented capabilities and limits.

Registering native HTTP hooks disables OpenCode's provider WebSocket transport
for affected requests. The `anthropic` provider does not advertise that
capability in the targeted OpenCode build; this coupling is rechecked when the
host version is updated.

## Options

Pass options with the object form of the `plugins` entry:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/oc-plugins/packages/oc-auth/dist",
      "options": { "cost": "zero" },
    },
  ],
}
```

| Option | Values                      | Effect                                                                                                              |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `cost` | `"api"` (default), `"zero"` | `"api"` shows API-equivalent cost. `"zero"` reports zero cost while a Claude Code subscription connection is active |

Restart the service after changing an option: `opencode service restart`.
Costs are recorded per message when it completes, so a change applies to new
messages only.

## Prompt cache stats

The package also ships a terminal plugin, loaded automatically with the
server plugin, that adds a **Cache** section to the session sidebar:

```text
Cache
94.1% hit · 5.9% miss
1.2M read · 45.2K write · 30K uncached
Last request 99.0% hit
```

- **hit** is the share of prompt tokens served from the cache (cache reads
  divided by every prompt token). **miss** is the rest: tokens written to the
  cache plus uncached input.
- The first two lines cover every request in the session, including title
  and compaction requests. **Last request** covers the newest response.
- Run `/cache`, or **Show prompt cache stats** from the command palette, to
  see the same numbers when the sidebar is hidden.

The stats use the token counts OpenCode records for each message, so they work
for any provider that reports cache usage.

## Refresh failures

A transient refresh failure keeps using a still-valid access token. When the
API returns a 401 and the recovery refresh is transiently unavailable, the
plugin returns an explicitly retryable 429 response so OpenCode can back off
the turn. Its `retry-after` header is the cooldown left, in whole seconds. When
another OpenCode process is the one waiting out that cooldown, the 429 comes
back at once.

Only a known OAuth error such as `invalid_grant` is terminal on its own, and
only that asks you to re-authenticate. Every other failure is retried with an
escalating cooldown. After ten consecutive transient failures for one account
the error is reported, naming the last cause (an HTTP status, a network
error, or an unreadable Keychain), and retries continue at the capped
cooldown, so the plugin recovers once the cause clears. The report comes
after at most about eight minutes, and closer to six with typical jitter.

When recovery from a 401 ends in either kind of error, the response carries
the plugin's message, so OpenCode shows what to do instead of a bare 401.

Problems that need your attention but do not fail a request are written to
the OpenCode service's stderr once per process, prefixed
`oc-auth:`, even with the debug log off. They are: refreshed
tokens that could not be saved back to Claude Code (its CLI will need to sign
in again), a refresh lock that is not coordinating processes, a Keychain that
could not be listed, a credential switch that could not be loaded, and a debug
log that stopped accepting writes.

The plugin has no Claude CLI subprocess fallback. After an expired or
terminal credential failure, run `claude` for the selected account and retry.
Use `/connect` again only when the stored OpenCode connection itself must be
replaced.

## Environment variables

| Variable                      | Purpose                                                                                            | Default                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `CLAUDE_CONFIG_DIR`           | Claude Code config directory for file credentials and account mapping                              | `~/.claude`                                          |
| `ANTHROPIC_CLI_VERSION`       | Claude CLI version in billing and user-agent values                                                | Pinned runtime value                                 |
| `ANTHROPIC_USER_AGENT`        | Complete user-agent override                                                                       | Claude CLI user agent                                |
| `ANTHROPIC_BETA_FLAGS`        | Replaces the base beta set; the required flags and inbound header flags still merge in             | Built-in base set, also used when the value is empty |
| `CLAUDE_CODE_ENTRYPOINT`      | Billing entrypoint override                                                                        | `sdk-cli`                                            |
| `CLAUDE_AUTH_DEBUG`           | `1` for the default debug log, or an absolute log file path. `0`, `false`, `no`, `off` all disable | Disabled                                             |
| `OC_AUTH_SECURITY_BIN`        | Path to the macOS `security` binary. For tests only. Changing it hands credentials to that program | `/usr/bin/security`                                  |
| `OC_AUTH_REFRESH_COOLDOWN_MS` | Base transient refresh cooldown                                                                    | `15000`                                              |
| `OC_AUTH_REFRESH_LOCK_TTL_MS` | Base cross-process refresh lock lease, capped at `120000`                                          | `20000`                                              |
| `OC_AUTH_REFRESH_LOCK_DIR`    | Refresh lock directory                                                                             | OpenCode data directory                              |
| `XDG_DATA_HOME`               | Selects the data directory holding the debug log and refresh locks                                 | `~/.local/share`                                     |

`ANTHROPIC_BETA_FLAGS` cannot drop `oauth-2025-04-20` or `claude-code-20250219`.
Subscription auth does not work without them, so they are re-added after any
override. It also cannot add `effort-2025-11-24` for a model that Claude Code
does not send it for. The plugin removes that flag per model after merging
everything else.

The long-running OpenCode service reads every variable above. Setting or
unsetting one takes effect only after `opencode service restart`.

## Troubleshooting

| Problem                              | Action                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Claude Code account in `/connect` | Run `claude`, then `opencode service restart`. If the Keychain failed, the `/connect` error text names the cause. Set `CLAUDE_AUTH_DEBUG=1` for the log events                  |
| Keychain locked or denied            | Unlock Keychain and grant the `security` command access                                                                                                                         |
| Credentials expired or rejected      | Run `claude` for that account and retry                                                                                                                                         |
| File credentials not found           | Check `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`                                                                                                   |
| Host compatibility error             | Check `opencode --version` and use a plugin release that supports that host. For a local checkout, update its source and run `pnpm run build`, then `opencode service restart`. |

For structured diagnostics:

```sh
export CLAUDE_AUTH_DEBUG=1
opencode service restart
```

The default file is `~/.local/share/opencode/oclaude-debug.log`, created
owner-readable only. Values under keys such as `accessToken`, `refreshToken`,
`account`, and `x-api-key`, plus any string shaped like an Anthropic token
(`sk-ant-…`) or a JWT, are redacted. Structure nested more than four levels
deep is replaced with a placeholder rather than logged. Account labels,
Keychain service names, and absolute config paths are not redacted, so review
logs before sharing them.

The plugin treats any value other than `1`/`true`/`yes`/`on` or
`0`/`false`/`no`/`off` as an absolute log file path, and the file is truncated on every
service start. A relative path is refused, and so is any existing file that is
not already one of these logs, such as `.credentials.json`. Disable logging
with `unset CLAUDE_AUTH_DEBUG` (or set it to `0`) followed by
`opencode service restart`. Copy the log first: each service start truncates
it.

## Verify host compatibility

Run `pnpm run test:host` to test the packed plugin against OpenCode 2.0.26.
The test installs the pinned CLI in a temporary directory and checks plugin
activation, credential import, catalog pricing, billing headers, and a
streamed read-tool round trip against a local mock API with a fake credential.
It does not read your credentials or send requests to Anthropic. Package
installation and OpenCode startup may require network access. CI runs this test
against both OpenCode 2.0.25 and the targeted release on Linux and macOS.

To check another V2 host version:

```sh
OC_AUTH_HEADLESS_HOST_VERSION=2.0.25 pnpm run test:host
```

`OC_AUTH_HEADLESS_MODEL` selects a model for the smoke test. Set
`OC_AUTH_HEADLESS_CUSTOM_MODEL=1` with the offline test to exercise a model
outside the catalog using an explicit test-only model definition.

Run `pnpm run test:headless` for the live read-tool test using your Claude Code
account. This sends a model request and consumes subscription usage.

On macOS, `OC_AUTH_LIVE_KEYCHAIN=1 pnpm test` also runs Keychain write-back
against the real `security` tool. It adds throwaway items named
`Claude Code-credentials-<random>` to the default keychain and deletes them
again. CI runs it on its macOS leg with a dedicated keychain.

## Disclaimer

This plugin uses Claude Code OAuth credentials for Anthropic requests.
Anthropic's terms may restrict subscription credentials to official clients.
This community integration may stop working if Anthropic changes its OAuth or
billing requirements. Use it at your own discretion.

## License

[MIT](LICENSE)
