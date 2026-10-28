# oc-usage

oc-usage is an OpenCode v2 plugin that shows how much of your Claude and ChatGPT
subscription usage limits you've used: the 5-hour and weekly windows, and when
each resets.

- `/usage` shows every subscription's usage in a dialog.
- `/show-usage on` adds a **Usage** section to the session sidebar, which stays
  until `/show-usage off`.

## Install

You need:

- OpenCode 2.0.27 or newer.
- For Claude: your Claude Code subscription imported as OpenCode's Anthropic
  connection, which [oc-auth](../oc-auth/README.md) does.
- For Codex: an OpenAI OAuth connection with a Codex-compatible bearer access
  token and ChatGPT account ID. Compatibility with OpenCode's native
  token-sharing **Sign in with ChatGPT** flow is unverified; see
  **Limitations**.

A subscription that isn't connected is left out of the sidebar, and `/usage`
says how to connect it.

oc-usage isn't published to npm yet. Build it from an oc-plugins checkout:

```sh
pnpm install
pnpm --filter @martinthommesen/oc-usage run build
```

Then add the built plugin to `plugins` in `opencode.jsonc`, and restart
OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/oc-plugins/packages/oc-usage/dist"],
}
```

oc-usage has no options.

## Use

### `/usage`

`/usage`, or **Show subscription usage** in the command palette, shows a dialog
like this:

```text
Claude
  5-hour          34%  resets in 2h 14m
  Weekly          62%  resets in 3d 4h
  Weekly Sonnet    3%
  Measured 3m ago.

Codex · Plus
  5-hour   12%  resets in 45m
  Weekly   40%  resets in 5d 1h
  Measured just now.
```

Each row is a usage limit window: the share of its limit you've used, and the
time left until it resets. A share the service didn't report shows as `?`. Codex
rows are the Codex limits of your ChatGPT plan, which the Codex CLI counts
against; ChatGPT's own chat limits aren't among them.

### `/show-usage`

| Command           | Effect                                            |
| ----------------- | ------------------------------------------------- |
| `/show-usage on`  | Show the **Usage** section in the session sidebar |
| `/show-usage off` | Hide it                                           |
| `/show-usage`     | Show it if it's hidden, hide it if it's shown     |

The setting lasts across restarts and applies to projects and windows using the
same OpenCode server/profile, wherever its server plugin is enabled. Turning it
on in one window shows it in the others. Right after OpenCode starts, the
section can take a few seconds to appear, while OpenCode starts the plugin's
server part. While the section is shown, it updates every minute. Unloading the
CLI plugin cancels its commands and polling. If the saved setting cannot be
restored, the CLI warns instead of claiming the section was shown;
`/show-usage on` or `off` can replace an unreadable saved value.

## How it works

- The server plugin reads each connection through OpenCode, which renews an
  OAuth sign-in that's about to expire. oc-usage never reads Claude Code's or
  Codex's own credential files. Tokens stay out of CLI and RPC reports and are
  sent only to the subscription service.
- It asks Anthropic's usage endpoint, the one Claude Code's `/usage` reads, and
  ChatGPT's Codex usage endpoint, the one the Codex CLI reads. Neither is
  documented. Anthropic rate-limits clients that don't identify as Claude Code
  hard, so oc-usage sends Claude Code's user agent, as oc-auth does.
- For the same connection identity in one loaded location, it asks Anthropic at
  most every 3 minutes and ChatGPT at most every minute. In between, `/usage`
  and the sidebar show the newest measurement. The dialog always shows its age;
  the sidebar shows the age when a refresh fails. When a service limits
  requests, oc-usage accepts decimal-integer `Retry-After` seconds, or waits 10
  minutes for absent, malformed, unrepresentable, or HTTP-date values. Minimum
  intervals begin at dispatch, after renewal; service-requested waits begin at
  response receipt and never shorten that minimum. Switching A→B→A or
  interrupting an attempt does not erase A's existing wait.
- HTTP requests, including reading their bodies, have a 15-second budget and
  never follow redirects. Credential lookup/renewal has a 45-second budget; each
  subscription's report has a 75-second total budget including permit waiting
  and post-request verification. The CLI report RPC has a 90-second budget;
  visibility RPCs have 15 seconds per call. Background visibility restoration
  retries separately while the CLI plugin remains loaded.
- A failed usage request retains an earlier measurement only when the resolved
  identity and token contents still match. Credential resolution failure,
  changed access, or rejection withdraws an unverified earlier measurement.
  Connection display labels do not affect identity or reset waits.
- A newly selected connection or named ChatGPT account can be measured at once.
  Replacing a token under the same identity withdraws its earlier measurement
  but preserves the remaining wait, including a longer service-requested wait.
  This conservative rule also applies to ordinary token renewal. After HTTP,
  oc-usage rechecks the selected sign-in and discards a changed selection's
  result. The CLI also clears retained reports on directory/credential changes.

## Limitations

- Both endpoints are undocumented and may change or go away. oc-usage reads
  their answers leniently, and says so when it can't read one.
- The Codex request format follows the Codex CLI's conventional OAuth bearer
  token. Native OpenCode token-sharing sign-ins may use different token/account
  semantics. Loading the plugin on OpenCode 2.0.27 does not establish that those
  credentials work with the usage endpoint; no live subscription credentials are
  used by its tests.
- Each loaded location keeps independent, in-memory measurement and scheduling
  history. Unload, reload, or server restart clears it. Separate directories or
  server processes can each request usage; there is no cross-location global
  rate limit.
- Account selection uses OpenCode's metadata, falling back to access-token
  claims. oc-usage cannot independently verify stale account metadata. It checks
  the last resolved selection, not an atomic guarantee against changes after
  that check.
- An API key connection has no subscription usage limits, so `/usage` says so
  and the sidebar leaves it out.

## Troubleshooting

| Problem                                                     | Action                                                                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/usage` says the RPC failed or timed out                   | Right after OpenCode starts, wait a moment and try again. If it keeps failing, check that oc-usage is in `plugins` in `opencode.jsonc`, inspect the server log, then restart the service |
| Claude says Anthropic refused the sign-in                   | Run `claude` to sign in to Claude Code again. oc-auth picks up the new sign-in                                                                                                           |
| Codex says ChatGPT refused the sign-in, or names no account | Check that the OpenAI OAuth connection supplies a Codex-compatible bearer token and account ID. Reconnect with a compatible method; native token-sharing compatibility is unverified     |
| A subscription says the service is limiting usage requests  | Wait; oc-usage asks again once the service's wait is over                                                                                                                                |

The server plugin writes to OpenCode's log, by default
`~/.local/share/opencode/log/opencode.log`. `sidebar_change_unannounced` means a
sidebar change was saved but couldn't be sent to other windows. They reread the
saved setting every minute, even while hidden. `usage_host_failed` and
`usage_connection_failed` identify failed credential operations without their
raw errors. `usage_http_failed`, `usage_request_failed`, and
`usage_request_limited` describe transport, status, and wait failures without
response bodies, request headers, or credentials.

CLI-side events such as `usage_rpc_failed`, `usage_rpc_unreadable`, and
`usage_sidebar_restore_failed` use the CLI's Effect console logger; they are not
guaranteed to appear in the server log. RPC failures are not all startup
failures: a saved visibility change can have succeeded even if its reply was
lost. Exhausted restoration retries hide unverified visibility and warn with
recovery guidance.

## Development

From the repository root:

```sh
pnpm install
pnpm run check
```

The root `AGENTS.md` lists every check and the shared lint and compiler policy.
Run `pnpm run test:host` in `packages/oc-usage` to check that the packed plugin
starts on OpenCode 2.0.27. Set `OC_USAGE_HEADLESS_HOST_VERSION` to test another
version, or to `oldest` to test the oldest version oc-usage supports, and set
`HEADLESS_KEEP=1` to keep the sandbox afterwards.
