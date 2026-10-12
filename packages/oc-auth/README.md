# oc-auth

[![CI](https://github.com/martinthommesen/oc-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/martinthommesen/oc-plugins/actions/workflows/ci.yml)

oc-auth is an OpenCode v2 plugin that imports Claude Code subscription
credentials into OpenCode's native Anthropic integration. It doesn't install a
custom model provider or ask for another browser sign-in.

## Install

You need:

- OpenCode 2.0.27 or newer. OpenCode v1 isn't supported.
- Claude Code, signed in by running `claude`.

oc-auth isn't published to npm yet. Build it from an oc-plugins checkout:

```sh
pnpm install
pnpm --filter @martinthommesen/oc-auth run build
```

Then add the built plugin to the plural `plugins` field in `opencode.jsonc`, and
restart OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/oc-plugins/packages/oc-auth/dist"],
}
```

After pulling changes, run the build again. OpenCode loads the new build the
next time it starts.

See the [OpenCode v2 plugin guide](https://opencode.ai/v2/docs/build/plugins)
for package and local-file configuration.

## Configure

### Import a Claude Code account

1. Start `opencode`.
2. Open `/connect`.
3. Choose **Anthropic**.
4. Choose **Import Claude Code subscription**.
5. Select a Claude Code account when more than one is available.

The import reads the selected account's current credentials and finishes on its
own, and OpenCode stores the resulting connection. Run `/connect` again to
import more accounts. OpenCode's connection UI handles activation and account
switching. `opencode auth login` offers the same import.

The plugin finds the accounts when the OpenCode service loads it, so the account
picker doesn't change while OpenCode runs. After you add or remove a Claude Code
account, restart the service before you open `/connect` again:

```sh
opencode service restart
```

### Options

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

| Option              | Type                    | Default                                            | Meaning                                                                                                             |
| ------------------- | ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `cost`              | `"api"` or `"zero"`     | `"api"`                                            | `"api"` shows API-equivalent cost. `"zero"` reports zero cost while a Claude Code subscription connection is active |
| `cliVersion`        | string                  | `"2.1.295"`, the pinned Claude Code version        | Claude Code version in the billing header and the user agent                                                        |
| `entrypoint`        | string                  | `"sdk-cli"`                                        | Claude Code entrypoint in the billing header and the user agent                                                     |
| `userAgent`         | string                  | `claude-cli/<cliVersion> (external, <entrypoint>)` | Complete user-agent override, sent verbatim                                                                         |
| `betaFlags`         | string, comma-separated | The built-in base set                              | Replaces the base beta set; the required flags and the request's own `anthropic-beta` flags still merge in          |
| `refreshCooldownMs` | integer above 0         | `15000`                                            | Base cooldown after a transient token refresh failure, in milliseconds                                              |
| `refreshLockTtlMs`  | integer above 0         | `20000`                                            | Base lease of the cross-process refresh lock, in milliseconds. A value above `120000` is capped at `120000`         |

`cliVersion`, `entrypoint`, and `userAgent` end up in request headers and the
system prompt. So the plugin turns every control character in them into a space
and trims the value, and something printable must remain.

After that cleanup, a value may hold only printable Latin-1 characters (U+0020
to U+007E and U+00A0 to U+00FF), which is what a request header can carry. A
value with any other character stops the plugin from starting.

`betaFlags` must name at least one flag. It can't drop `oauth-2025-04-20` or
`claude-code-20250219`: subscription auth doesn't work without them, so the
plugin adds them back after any override. It also can't add `effort-2025-11-24`
for a model that Claude Code doesn't send it for. The plugin removes that flag
per model after it merges everything else.

`betaFlags` goes into the `anthropic-beta` header. The plugin splits it at
commas, trims each flag, and drops empty ones. Each flag that remains may hold
only printable Latin-1 characters, so a line break or a tab inside a flag stops
the plugin from starting.

An invalid option stops the plugin from starting. That covers a value of the
wrong type, a number out of range, and an option name the plugin doesn't know.
No invalid option is replaced by its default. OpenCode's log names each problem,
and lists the known options for an unknown name. For example:
`oc-auth did not start because its options in opencode.jsonc are invalid. refreshCooldownMs: Expected a value greater than 0. Correct the options, then restart OpenCode.`

Restart the service after you change an option: `opencode service restart`.
OpenCode records costs per message when the message completes, so a change to
`cost` applies to new messages only.

### Models missing from OpenCode's catalog

If `/models` doesn't list a newly released model, add it to OpenCode's native
provider configuration. For example, Mythos 5.1 isn't in the OpenCode 2.0.26
catalog yet, but you can configure it with the metadata from Claude Code
2.1.295:

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
`anthropic/claude-mythos-5-1`. This only makes the model selectable. It doesn't
grant your account access, and Anthropic may still reject subscription requests
for the model. Configure other new model IDs the same way, with their own
documented capabilities and limits.

## Environment variables

Everything you configure in oc-auth itself is an [option](#options). The plugin
reads only these variables, which belong to other programs or to tests:

| Variable                   | Purpose                                                                                                  | Default                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------- |
| `CLAUDE_CONFIG_DIR`        | Claude Code config directory, for file credentials and account labels                                    | `~/.claude`             |
| `HOME`                     | Home directory, where the Claude Code and OpenCode directories are by default (`USERPROFILE` on Windows) | Set by the system       |
| `XDG_DATA_HOME`            | Parent of OpenCode's data directory, which holds the refresh locks. Used only when it's an absolute path | `~/.local/share`        |
| `OC_AUTH_REFRESH_LOCK_DIR` | Refresh lock directory. For tests only                                                                   | OpenCode data directory |
| `OC_AUTH_SECURITY_BIN`     | Path to the macOS `security` binary. For tests only. Changing it hands credentials to that program       | `/usr/bin/security`     |

The OpenCode service reads these variables when it starts, so a change takes
effect only after `opencode service restart`. The host test's variables are in
[Development](#development).

## How it works

### Credential stores

A credential store is where Claude Code keeps one account's credentials: a
Keychain item or its credentials file.

On macOS, the plugin finds the `Claude Code-credentials*` items in the Keychain,
and labels each account with its subscription tier and email when it can. On
Linux and Windows, it reads `~/.claude/.credentials.json`.

On macOS, the plugin falls back to that file only when no Keychain item holds a
usable credential. An item with only MCP tokens doesn't count. If no item could
be read because the Keychain is locked, denied access, or timed out, the plugin
reports that error instead of falling back, so the cause isn't hidden. A
credentials file that exists but can't be read is reported the same way, not as
missing.

Set `CLAUDE_CONFIG_DIR` to use a different Claude Code config directory:

```sh
export CLAUDE_CONFIG_DIR="$HOME/.claude-work"
```

On Linux and Windows, the variable selects the credentials file. On macOS, the
Keychain stays the credential store. There, the variable only selects the config
directory that account labels (the email) come from, and the file to fall back
to when no Keychain item holds a credential.

OpenCode keeps the connection. The plugin doesn't write OpenCode's `auth.json`
files or run a background sync timer.

### Requests

- Requests go through OpenCode's native Anthropic provider. Its `anthropic`
  catalog supplies the models, their capabilities, and their limits, and the
  plugin keeps no model list of its own. So new catalog models, such as Claude
  Opus 5.5, Sonnet 5.5, and Haiku 5.5, need no plugin update. Legacy models and
  dated snapshots keep their model-specific beta exclusions, and the betas for a
  custom model alias follow the model ID in the request body.
- The plugin adds the Claude Code billing header, the beta flags, and the
  request headers that subscription traffic needs. It does this for the agent
  loop and for title, compaction, and `generate` requests. The defaults match
  Claude Code 2.1.295 and its bundled Anthropic SDK 0.128.0.
- The system prompt becomes the billing header and Claude Code's identity. The
  plugin moves the rest of the system prompt into the first user message.
- Anthropic's billing validator rejects tool names other than Claude Code's, so
  the plugin renames tools in the request body to `mcp_` plus the name with its
  first letter in upper case: `read_file` becomes `mcp_Read_file`. It renames
  deferred tool-search references too. The response gets OpenCode's own names
  back, so tool calls render and behave as usual. The plugin adds the name
  mapping to the first user message, so the model can follow instructions
  written with OpenCode's names.
- OpenCode keeps its native API pricing, so the sidebar and prompt footer show
  what subscription traffic would cost at API rates. Anthropic doesn't bill that
  amount to a subscription. Set the `cost` option to `"zero"` to report zero
  cost instead.
- OpenCode handles generic rate-limit and provider retries.

### Keeping credentials current

- The plugin refreshes credentials that are about to expire through Anthropic's
  OAuth endpoint. One OpenCode process at a time refreshes a credential store,
  under a cross-process refresh lock. The plugin writes the new tokens back into
  the store they came from, so Claude Code stays signed in, and reads them back
  to confirm the write.
- The plugin doesn't refresh while it can't read the credential store, because
  it couldn't save the new tokens, and Claude Code would be signed out.
- When Claude Code or another process rotates the tokens in a store, the plugin
  takes them up without a session restart. It re-reads the store at most every
  30 seconds, beside a request rather than in front of it, so a rotation applies
  from the next request. A request whose token has expired waits for the
  re-read.
- After a 401, the plugin sends the request again at most twice: once with
  credentials taken up from the store, and once with refreshed ones.

A transient refresh failure, such as a network error, keeps the current access
token while it's still valid. When the API answers with a 401 and the refresh
fails transiently or is in a cooldown, the plugin answers with a 429 that
OpenCode retries. Its `retry-after` header is the cooldown left, in whole
seconds. When another OpenCode process is waiting out that cooldown, the 429
comes back at once.

Only an OAuth error that rejects the refresh token, such as `invalid_grant`,
fails for good and asks you to sign in to Claude Code again. The plugin retries
every other failure with a growing cooldown. After ten failures in a row for one
store, it reports the error and names the last cause: an HTTP status, a network
error, or credentials it couldn't read. It keeps retrying at the longest
cooldown, so it recovers once the cause clears. With the default
`refreshCooldownMs`, the report comes after about eight minutes at most, and
closer to six with typical jitter.

When recovery from a 401 ends in either kind of error, the response carries the
plugin's message, so OpenCode shows what to do instead of a bare 401.

### Prompt cache stats

The package also ships a CLI plugin, which OpenCode loads with the server
plugin. It adds a **Cache** section to the session sidebar:

```text
Cache
94.1% hit · 5.9% miss
1.2M read · 45.2K write · 30K uncached
Last request 99.0% hit
```

- **hit** is the share of prompt tokens served from the cache: cache reads
  divided by every prompt token. **miss** is the rest: tokens written to the
  cache plus uncached input.
- The first two lines cover every request in the session, including title and
  compaction requests. **Last request** covers the newest response.
- Run `/cache`, or **Show prompt cache stats** from the command palette, to see
  the same numbers when the sidebar is hidden.

The stats use the token counts OpenCode records for each message, so they work
for any provider that reports cache usage.

### Host compatibility

This release targets `@opencode/plugin@2.0.27` and Effect 4.0.1. It runs on the
`effect` instance the host provides to plugins. OpenCode 2.0.27 is the minimum
version: earlier hosts don't provide the stable Effect module paths this release
imports. Rather than match version strings, the plugin checks at load that the
host offers every plugin API it needs, such as `model.transform` and
`model.reload`, and names any that are missing.

## Limitations

- The plugin uses Claude Code OAuth credentials for Anthropic requests.
  Anthropic's terms may restrict subscription credentials to official clients.
  This community integration may stop working if Anthropic changes its OAuth or
  billing requirements. Use it at your own discretion.
- A model's availability depends on Anthropic granting your account access to
  it.
- The plugin has no Claude Code subprocess to fall back on. After an expired or
  rejected credential, run `claude` for the selected account and try again. Run
  `/connect` again only when the stored OpenCode connection itself must be
  replaced.
- Registering native HTTP hooks turns off OpenCode's provider WebSocket
  transport for the requests they affect. The `anthropic` provider doesn't
  advertise that transport in the targeted OpenCode build. Check this again when
  the targeted host version changes.

## Troubleshooting

| Problem                                                  | Action                                                                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Claude Code account in `/connect`                     | Run `claude`, then `opencode service restart`. If the Keychain failed, the `/connect` error names the cause                                                           |
| The plugin doesn't start                                 | Check OpenCode's log, which names each invalid option. Fix the `options` in `opencode.jsonc`, then run `opencode service restart`                                     |
| Keychain locked or access denied                         | Unlock the Keychain, and let the `security` command access it                                                                                                         |
| Credentials expired or rejected                          | Run `claude` for that account, then try again                                                                                                                         |
| Claude Code token refresh has failed many times in a row | Check your network connection, and that Claude Code's credentials can be read. The plugin keeps retrying                                                              |
| File credentials not found                               | Check `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json`                                                                                         |
| OpenCode lacks plugin APIs oc-auth needs                 | Check `opencode --version`, and use an oc-auth release built for that version. For a local checkout, update it, run `pnpm run build`, then `opencode service restart` |

### Logs

The plugin writes to OpenCode's own log, by default
`~/.local/share/opencode/log/opencode.log`, and keeps no log file of its own.
Each record's message is a stable event name, such as
`refresh_writeback_failed`, with fields such as `source`, which names the
credential store.

Warnings carry metadata only, such as credential store names, counts, and status
codes, never a token, a message, or a path. Each of these events is a warning:

| Event                      | Meaning                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refresh_writeback_failed` | The refreshed tokens couldn't be saved back to the credential store, so Claude Code has to sign in again once its current token expires             |
| `refresh_lock_degraded`    | The refresh lock directory or a lock file is unusable, so OpenCode doesn't take turns refreshing the `lock` store. Overlap can sign Claude Code out |
| `refresh_lease_unwritten`  | A refresh lock lease couldn't be written, so the plugin doesn't refresh under it. `lease` names the write, `lock` the store as lock files do        |
| `credential_temp_kept`     | A temp file holding refreshed tokens couldn't be deleted from the Claude Code config directory. Later write-backs retry once it's an hour old       |
| `credential_sync_failed`   | The Claude Code config directory couldn't be synced after a write-back, so a crash could undo the write. The write-back itself succeeded            |
| `credential_sweep_failed`  | Leftover `.credentials.json.*.tmp` files holding tokens couldn't be listed or removed in the Claude Code config directory. `step` says which        |
| `keychain_list_failed`     | The Keychain items couldn't be listed, so only the primary Claude Code account is offered                                                           |
| `credential_reload_failed` | The newly selected Anthropic credential couldn't be loaded, so no Claude Code credential is in use until the next switch                            |

Debug records add the details, such as error messages and config paths. OpenCode
keeps them only when it logs at debug level (its `--log-level` flag). They pass
through redaction first: values under keys such as `accessToken`,
`refreshToken`, `account`, and `x-api-key`, and any Anthropic token
(`sk-ant-...`) or JWT inside a string, are redacted. Structure nested more than
four levels deep is replaced with a placeholder. Keychain item names and config
paths aren't redacted, so review debug records before you share them. No record
carries a prompt, a request or response body, or model output.

## Development

From the repository root:

```sh
pnpm install
pnpm run check
```

The root `AGENTS.md` lists every check and the shared lint and compiler policy.

### Verify host compatibility

Run `pnpm run test:host` to test the packed plugin against OpenCode 2.0.27. The
test installs that CLI and the packed plugin in a temporary directory, loads the
plugin with options from the generated `opencode.json`, and checks plugin
loading, credential import, catalog pricing, billing headers, and a streamed
read-tool round trip. It runs against a local mock API with a fake credential,
so it doesn't read your credentials or send requests to Anthropic. Installing
packages and starting OpenCode can require network access. CI runs this test on
Linux and macOS, against the oldest supported host and the targeted release.

To check another OpenCode v2 version:

```sh
OC_AUTH_HEADLESS_HOST_VERSION=2.0.27 pnpm run test:host
```

Set it to `oldest` to check the oldest version oc-auth supports, which its
`package.json` records as `engines.opencode`. Set `HEADLESS_KEEP=1` to keep the
sandbox afterwards.

`OC_AUTH_HEADLESS_MODEL` selects the model for the test, by default
`anthropic/claude-sonnet-5-5`. Set `OC_AUTH_HEADLESS_CUSTOM_MODEL=1` with the
offline test to test a model outside the catalog, with a model definition
written for the test.

Run `pnpm run test:headless` for the live read-tool test with your Claude Code
account. It reads your Claude Code accounts and copies the first one's access
token, without its refresh token, into the sandbox. It sends a model request,
which uses subscription usage, and writes nothing outside the sandbox. The copy
can't refresh, so the test never spends your account's refresh token: if the
access token expires within five minutes, or Anthropic rejects it, the test
fails and says why. Run `claude`, then try again.

To test near-expiry refresh and write-back, set
`OC_AUTH_HEADLESS_REFRESH_CONFIG_DIR` to a disposable Claude Code config
directory. The live test then reads only that directory's credentials file, and
makes it expire so the plugin refreshes it. Its refresh token rotates at
Anthropic, and the new credentials stay in that directory.

On macOS, `OC_AUTH_LIVE_KEYCHAIN=1 pnpm test` also tests Keychain write-back
against the real `security` tool. It adds throwaway items named
`Claude Code-credentials-<random>` to the default keychain and deletes them
again. CI runs it on its macOS leg with a dedicated keychain.

## License

[MIT](LICENSE)
