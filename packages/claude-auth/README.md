# opencode-claude-auth

[![npm](https://img.shields.io/npm/v/opencode-claude-auth)](https://www.npmjs.com/package/opencode-claude-auth)
[![CI](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml)

OpenCode v2 plugin that imports Claude Code subscription credentials into
OpenCode's native Anthropic integration. It does not install a custom model
provider or require another browser login.

## Requirements

- `opencode2 v0.0.0-beta-18381`
- Claude Code installed and authenticated by running `claude`

The OpenCode v2 plugin API is beta. Version 3.0.0 targets the exact host build
above and reports a compatibility error if required host capabilities are
missing. OpenCode v1 is not supported.

## Install

Install globally with the OpenCode v2 CLI:

```sh
opencode2 plugin add opencode-claude-auth
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

1. Start `opencode2`.
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
opencode2 service restart
```

`opencode2 auth login` also remains available in v2, but `/connect` is the
primary TUI flow documented for this plugin.

## Credential Sources

On macOS, the plugin discovers `Claude Code-credentials*` entries in Keychain
and labels accounts with their subscription tier and email when available. On
Linux and Windows, and as a macOS fallback, it reads
`~/.claude/.credentials.json`.

Set `CLAUDE_CONFIG_DIR` to use a different Claude Code configuration directory:

```sh
export CLAUDE_CONFIG_DIR="$HOME/.claude-work"
```

OpenCode owns connection persistence. The plugin does not write OpenCode
`auth.json` files or maintain a background synchronization timer.

## Behavior

- Uses OpenCode's native Anthropic provider and model catalog.
- Reports zero dollar cost while a Claude Code subscription connection is
  active. API-key and environment connections retain native API pricing.
- Adds the Claude Code billing identity, supported beta flags, request headers,
  and semantic tool aliases required for subscription traffic.
- Lets OpenCode own generic rate-limit and provider retries.
- Refreshes near-expiry credentials through Anthropic's current OAuth endpoint,
  with per-account locking, cooldowns, and guarded source write-back.
- Adopts credentials rotated by Claude Code or another process without a
  session restart.
- Performs at most two bounded retries after a 401: one source adoption and one
  direct refresh.

The native Anthropic catalog supplies the available models, capabilities, and
limits. This package does not maintain a separate model list.

Registering native HTTP hooks disables OpenCode's provider WebSocket transport
for affected requests. Anthropic does not advertise that capability in the
targeted OpenCode build; this coupling is rechecked when the host version is
updated.

## Refresh Failures

A transient refresh failure keeps using a still-valid access token. If the
token has already expired, the plugin returns an explicitly retryable response
so OpenCode can back off the turn.

There is intentionally no Claude CLI subprocess fallback. After an expired or
terminal credential failure, run `claude` for the selected account and retry.
Use `/connect` again only when the stored OpenCode connection itself must be
replaced.

## Environment Variables

| Variable                                   | Purpose                                                               | Default                   |
| ------------------------------------------ | --------------------------------------------------------------------- | ------------------------- |
| `CLAUDE_CONFIG_DIR`                        | Claude Code config directory for file credentials and account mapping | `~/.claude`               |
| `ANTHROPIC_CLI_VERSION`                    | Claude CLI version in billing and user-agent values                   | Pinned runtime value      |
| `ANTHROPIC_USER_AGENT`                     | Complete user-agent override                                          | Claude CLI user agent     |
| `ANTHROPIC_BETA_FLAGS`                     | Comma-separated beta flag override                                    | Required supported flags  |
| `CLAUDE_CODE_ENTRYPOINT`                   | Billing entrypoint override                                           | `sdk-cli`                 |
| `CLAUDE_AUTH_DEBUG`                        | `1` for the default debug log or a custom file path                   | Disabled                  |
| `OPENCODE_CLAUDE_AUTH_REFRESH_COOLDOWN_MS` | Base transient refresh cooldown                                       | `15000`                   |
| `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_TTL_MS` | Base cross-process refresh lock lease                                 | `20000`                   |
| `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR`    | Refresh lock directory                                                | `~/.local/share/opencode` |

## Troubleshooting

| Problem                              | Action                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| No Claude Code account in `/connect` | Run `claude`, then `opencode2 service restart`                                |
| Keychain locked or denied            | Unlock Keychain and grant the `security` command access                       |
| Credentials expired or rejected      | Run `claude` for that account and retry                                       |
| File credentials not found           | Check `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json` |
| Host compatibility error             | Install the required `opencode2` beta or a plugin release matching your host  |

For structured diagnostics:

```sh
export CLAUDE_AUTH_DEBUG=1
opencode2 service restart
```

The default file is
`~/.local/share/opencode/claude-auth-debug.log`. Token-like values and known
secret fields are redacted, but review logs before sharing them. Disable
logging after reproduction with `unset CLAUDE_AUTH_DEBUG`.

## Disclaimer

This plugin uses Claude Code OAuth credentials for Anthropic requests.
Anthropic's terms may restrict subscription credentials to official clients.
This community integration may stop working if Anthropic changes its OAuth or
billing requirements. Use it at your own discretion.

## License

[MIT](LICENSE)
