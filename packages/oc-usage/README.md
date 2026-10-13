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
- For ChatGPT: OpenAI connected with **Sign in with ChatGPT** in `/connect`.

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

The setting lasts across restarts, and applies to every project and every
OpenCode window: turning it on in one window shows it in the others. Right after
OpenCode starts, the section can take a few seconds to appear, while OpenCode
starts the plugin's server part. While the section is shown, it updates every
minute.

## How it works

- The server plugin reads each connection through OpenCode, which renews an
  OAuth sign-in that's about to expire. oc-usage never reads Claude Code's or
  Codex's own credential files. Tokens stay out of CLI and RPC reports and are
  sent only to the subscription service.
- It asks Anthropic's usage endpoint, the one Claude Code's `/usage` reads, and
  ChatGPT's Codex usage endpoint, the one the Codex CLI reads. Neither is
  documented. Anthropic rate-limits clients that don't identify as Claude Code
  hard, so oc-usage sends Claude Code's user agent, as oc-auth does.
- For the same connection identity in one project, it asks Anthropic at most
  every 3 minutes and ChatGPT at most every minute. In between, `/usage` and the
  sidebar show the newest measurement. The dialog always shows its age; the
  sidebar shows the age when a refresh fails. When a service limits requests,
  oc-usage uses numeric `Retry-After` seconds, or 10 minutes for absent,
  malformed, unrepresentable, or HTTP-date values. Retry intervals are measured
  from the request's start and never shorten the subscription's minimum
  interval.
- A request that fails, or takes more than 15 seconds, keeps the earlier
  measurement and says why it couldn't be refreshed. When a service refuses the
  sign-in, the earlier measurement is withdrawn. A request never follows a
  redirect.
- When you switch a connection to another account, oc-usage measures the new
  account at once and never shows the old account's usage for it.

## Limitations

- Both endpoints are undocumented and may change or go away. oc-usage reads
  their answers leniently, and says so when it can't read one.
- OpenCode runs a server plugin for each project you open, and each keeps its
  own measurements. Several open projects each ask the services, at most at the
  intervals above.
- An API key connection has no subscription usage limits, so `/usage` says so
  and the sidebar leaves it out.

## Troubleshooting

| Problem                                                     | Action                                                                                                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/usage` says oc-usage's server plugin didn't answer        | Right after OpenCode starts, wait a moment and try again. If it keeps failing, check that oc-usage is in `plugins` in `opencode.jsonc`, then run `opencode service restart` |
| Claude says Anthropic refused the sign-in                   | Run `claude` to sign in to Claude Code again. oc-auth picks up the new sign-in                                                                                              |
| Codex says ChatGPT refused the sign-in, or names no account | Reconnect OpenAI with `/connect` and **Sign in with ChatGPT**                                                                                                               |
| A subscription says the service is limiting usage requests  | Wait; oc-usage asks again once the service's wait is over                                                                                                                   |

oc-usage writes to OpenCode's log, by default
`~/.local/share/opencode/log/opencode.log`. `sidebar_change_unannounced` means a
sidebar change was saved but couldn't be sent to other windows. They reread the
saved setting every minute, even while hidden. `usage_rpc_failed` records the
failed operation without response bodies or credentials. Exhausted sidebar
restoration retries show a warning with recovery guidance.

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
