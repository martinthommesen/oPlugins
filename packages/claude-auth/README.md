# opencode-claude-auth

[![npm](https://img.shields.io/npm/v/opencode-claude-auth)](https://www.npmjs.com/package/opencode-claude-auth)
[![CI](https://github.com/martinthommesen/opencode-claude-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/martinthommesen/opencode-claude-auth/actions/workflows/ci.yml)

OpenCode v2 plugin that imports Claude Code subscription credentials into
OpenCode's native Anthropic integration. It does not install a custom model
provider or require another browser login.

## Requirements

- OpenCode 2.0.7 or newer with the compatible V2 Promise plugin API
- Claude Code installed and authenticated by running `claude`

This release targets `@opencode/plugin@2.0.26` and uses `model.transform` and
`model.reload`. Rather than match version strings, the plugin checks for the
host capabilities it needs at load and reports any missing ones. Older beta
builds that expose only `catalog.transform` and `catalog.reload` are not
supported. OpenCode v1 is not supported.

## Install

Install globally with the OpenCode v2 CLI:

```sh
opencode plugin add opencode-claude-auth
```

Or add the package to the plural `plugins` field in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-claude-auth"],
}
```

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

The account picker is captured when the OpenCode service loads the plugin. If
you add or remove a Claude Code account later, refresh it before reopening
`/connect`:

```sh
opencode service restart
```

`opencode auth login` also remains available in v2, but `/connect` is the
primary TUI flow documented for this plugin.

## Credential Sources

On macOS, the plugin discovers `Claude Code-credentials*` entries in Keychain
and labels accounts with their subscription tier and email when available. On
Linux and Windows it reads `~/.claude/.credentials.json`.

macOS falls back to that file only when no Keychain entry exists. If Keychain
access itself fails — locked, denied, or timing out — the error is reported
instead, because a silent fallback would hide the cause.

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
- Reports zero dollar cost while a Claude Code subscription connection is
  active. API-key and environment connections retain native API pricing.
- Adds the Claude Code billing identity, supported beta flags, and request
  headers required for subscription traffic, including title, compaction, and
  transient generation requests. The current wire defaults match Claude Code
  2.1.295 and its bundled Anthropic SDK 0.128.0.
- Renames tools to the Claude Code `mcp_<PascalCase>` convention in the
  request body, because Anthropic's billing validator rejects other tool
  names. The response restores OpenCode's own names, so tool calls keep their
  native rendering and behavior. The first user message carries the name
  mapping so the model can follow instructions written with OpenCode names.
  Deferred tool-search references are renamed consistently as well.
- Lets OpenCode own generic rate-limit and provider retries.
- Refreshes near-expiry credentials through Anthropic's current OAuth endpoint,
  with per-account locking, cooldowns, and guarded source write-back.
- Adopts credentials rotated by Claude Code or another process without a
  session restart.
- Performs at most two bounded retries after a 401: one source adoption and one
  direct refresh.

OpenCode's `anthropic` provider catalog supplies the available models,
capabilities, and limits. This package does not maintain a separate model list.
New catalog models therefore need no plugin allowlist update, including Claude
Opus 5.5, Sonnet 5.5, and Haiku 5.5. Actual availability still
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

## Refresh Failures

A transient refresh failure keeps using a still-valid access token. When the
API returns a 401 and the recovery refresh is transiently unavailable, the
plugin returns an explicitly retryable 429 response so OpenCode can back off
the turn.

Only a known OAuth error such as `invalid_grant` is terminal on its own.
Every other failure is retried with an escalating cooldown, and after ten
consecutive transient failures for one account the plugin stops retrying and
asks you to re-authenticate. That bounds a permanent failure with an
unfamiliar error code, such as a lapsed subscription, to at most about eight
minutes of retries, and closer to six with typical jitter.

There is intentionally no Claude CLI subprocess fallback. After an expired or
terminal credential failure, run `claude` for the selected account and retry.
Use `/connect` again only when the stored OpenCode connection itself must be
replaced.

## Environment Variables

| Variable                                   | Purpose                                                                                            | Default                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `CLAUDE_CONFIG_DIR`                        | Claude Code config directory for file credentials and account mapping                              | `~/.claude`                                          |
| `ANTHROPIC_CLI_VERSION`                    | Claude CLI version in billing and user-agent values                                                | Pinned runtime value                                 |
| `ANTHROPIC_USER_AGENT`                     | Complete user-agent override                                                                       | Claude CLI user agent                                |
| `ANTHROPIC_BETA_FLAGS`                     | Replaces the base beta set; required, per-model, and inbound header values still merge in          | Required base set, also used when the value is empty |
| `CLAUDE_CODE_ENTRYPOINT`                   | Billing entrypoint override                                                                        | `sdk-cli`                                            |
| `CLAUDE_AUTH_DEBUG`                        | `1` for the default debug log, or an absolute log file path. `0`, `false`, `no`, `off` all disable | Disabled                                             |
| `OPENCODE_CLAUDE_AUTH_SECURITY_BIN`        | Path to the macOS `security` binary. A test seam; changing it hands credentials to that program    | `/usr/bin/security`                                  |
| `OPENCODE_CLAUDE_AUTH_REFRESH_COOLDOWN_MS` | Base transient refresh cooldown                                                                    | `15000`                                              |
| `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_TTL_MS` | Base cross-process refresh lock lease, capped at `120000`                                          | `20000`                                              |
| `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR`    | Refresh lock directory                                                                             | OpenCode data directory                              |
| `XDG_DATA_HOME`                            | Selects the data directory holding the debug log and refresh locks                                 | `~/.local/share`                                     |

`ANTHROPIC_BETA_FLAGS` cannot drop `oauth-2025-04-20` or `claude-code-20250219`.
Subscription auth does not work without them, so they are re-added after any
override.

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

The default file is `~/.local/share/opencode/claude-auth-debug.log`, created
owner-readable only. Values under keys such as `accessToken`, `refreshToken`,
`account`, and `x-api-key`, plus any string shaped like an Anthropic token
(`sk-ant-…`) or a JWT, are redacted at any nesting depth. Account labels,
Keychain service names, and absolute config paths are not, so review logs
before sharing them.

Any value other than `1`/`true`/`yes`/`on` is treated as an absolute log file
path, and the file is truncated on every service start. A relative path or a
`.credentials.json` filename is refused rather than written to. Disable logging
with `unset CLAUDE_AUTH_DEBUG` (or set it to `0`) followed by
`opencode service restart`. Copy the log first: each service start truncates
it.

## Verify host compatibility

Run `pnpm run test:host` to test the packed plugin against OpenCode 2.0.26.
The test installs the pinned CLI in a temporary directory and checks plugin
activation, credential import, subscription pricing, billing headers, and a
streamed read-tool round trip against a local mock API with a fake credential.
It does not read your credentials or send requests to Anthropic. Package
installation and OpenCode startup may require network access. CI runs this test
against both OpenCode 2.0.7 and the targeted release on Linux and macOS.

To check another V2 host version:

```sh
CLAUDE_AUTH_HEADLESS_HOST_VERSION=2.0.7 pnpm run test:host
```

`CLAUDE_AUTH_HEADLESS_MODEL` selects a model for the smoke test. Set
`CLAUDE_AUTH_HEADLESS_CUSTOM_MODEL=1` with the offline test to exercise a model
outside the catalog using an explicit test-only model definition.

Run `pnpm run test:headless` for the live read-tool test using your Claude Code
account. This sends a model request and consumes subscription usage.

## Disclaimer

This plugin uses Claude Code OAuth credentials for Anthropic requests.
Anthropic's terms may restrict subscription credentials to official clients.
This community integration may stop working if Anthropic changes its OAuth or
billing requirements. Use it at your own discretion.

## License

[MIT](LICENSE)
