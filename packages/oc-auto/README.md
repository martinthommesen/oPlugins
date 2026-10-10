# oc-auto

OpenCode v2 plugin that sends permission prompts to a reviewer model before
they reach you. It uses Codex's
[Auto-review](https://developers.openai.com/codex/concepts/sandboxing/auto-review).

When a permission rule resolves to **ask**, the plugin shows the reviewer the
conversation and the exact action, and applies its verdict:

- An allow decision runs the action without a prompt.
- A deny decision refuses the action. The agent gets the reviewer's reason and
  Codex's instruction to find a materially safer path or stop and ask.
- An ask decision leaves the normal prompt for you, with a note saying why.
  This happens when the review fails, times out, lacks context, or keeps denying.

Rules that already resolve to **allow** are not reviewed, and configured
**deny** rules never reach the plugin.

## Requirements

- OpenCode 2.0.26 or newer.
- OpenAI connected with "Sign in with ChatGPT". Run `/connect` and choose
  OpenAI. The reviewer uses that sign-in to call the ChatGPT Codex backend.
  An OpenAI API key does not work.

## Install

Run `pnpm install` at the root of the oc-plugins checkout, then add this
package's directory to `plugins` in `opencode.jsonc`, globally or per project:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/oc-plugins/packages/oc-auto"],
}
```

## Options

Pass options with the object form of the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/oc-plugins/packages/oc-auto",
      "options": { "fallbackModel": "gpt-6-luna", "timeout": "60 seconds" },
    },
  ],
}
```

| Option                  | Default                                 | Meaning                                                                     |
| ----------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| `model`                 | `codex-auto-review`                     | Reviewer model requested first.                                             |
| `fallbackModel`         | `gpt-5.5`                               | Used after the backend rejects `model`. Set it equal to `model` to disable. |
| `reasoningEffort`       | `low`                                   | `minimal`, `low`, `medium`, or `high`.                                      |
| `timeout`               | `90 seconds`                            | Positive, finite deadline including context loading, retries, and fallback. |
| `maxConsecutiveDenials` | `3`                                     | Positive integer. Consecutive denials per user turn before asking you.      |
| `maxTotalDenials`       | `10`                                    | Positive integer. Total denials per user turn before asking you.            |
| `extraPolicy`           | (empty)                                 | Text added to the security policy, such as trusted hosts or repositories.   |
| `baseUrl`               | `https://chatgpt.com/backend-api/codex` | HTTP(S) backend URL without credentials, a query, or a fragment.            |

`timeout` is a string such as `"60 seconds"`, and the denial limits are
numbers, not strings.

An invalid option stops the plugin from loading: a value of the wrong type,
a value out of range, a `reasoningEffort` not in the list, or an option name
not in the table. No invalid option is replaced by its default. OpenCode's
log then shows an error that names each invalid option and the problem, and
permission prompts behave as if the plugin were not installed until you
correct the option and restart OpenCode.

Only set `baseUrl` to a backend you trust. It receives your ChatGPT access token
and conversation. Use HTTPS unless testing a local backend. Requests do not
follow redirects.

## How it works

`codex-auto-review` is the hidden model Codex uses for Auto-review.
OpenAI enables it per account and does not document it, so it
can change or disappear. When the backend rejects it, the plugin switches to
`fallbackModel` until the plugin reloads and logs a warning. Other request
errors do not select the fallback.

The instructions are Codex's Auto-review policy template and default security
policy, copied unchanged from the Codex repository. Its source is documented
in `src/vendor/codex/UPSTREAM.md`. The plugin adds a short section describing
OpenCode and replaces Codex's output contract with one that says the
reviewer has no tools.

The reviewer sees user messages, the agent's messages and tool calls,
conversation summaries, and the planned action. The planned action
contains the permission request and the exact tool call that raised it.
Tool outputs are left out. Each transcript entry quotes its text separately
from its speaker label, so embedded labels remain part of that entry's text.
For a subagent, the reviewer also sees the user's messages from the root
session, and the subagent's own "user" messages are labeled as coming from
the delegating agent. If the root session or originating tool call cannot
be identified, the plugin asks you instead.

The transcript has a 48,000-character budget. Older agent entries can be
omitted, and agent text and historical tool inputs can be shortened. User
messages are never shortened. The planned action has an 8,000-character limit
and is never shortened. If either cannot fit, the plugin asks you instead.

A turn starts at the newest user message in the root session. The root and
its subagents share denial counts. Three consecutive denials or ten total
denials per turn hand the decision back to you. An approval resets only the
consecutive count. Reaching the total limit keeps subsequent denials with you
until a new user turn, even after an approval.

Missing or expired sign-ins, backend errors, timeouts, unfinished response
streams, and unreadable answers leave the prompt for you, with the reason.

The plugin's log records go to OpenCode's log. Each verdict is logged at info
level with metadata only: the permission action, the verdict, and the
reviewer model. The reviewer's rationale and the reason a review failed are
logged only at debug level, after secrets are redacted.

## Limitations

- Unlike Codex's reviewer, this one cannot run read-only commands to inspect
  files before deciding. The policy tells it to lean conservative when the
  decision depends on state it cannot see.
- The plugin does not refresh the ChatGPT sign-in. OpenCode renews it when it
  sends a request to an OpenAI model; until then an expired sign-in means
  reviews fall back to asking you.
- Like Codex's Auto-review, this is not a security boundary. A reviewer can be
  misled, and it only sees actions that reach an `ask` rule. Keep `deny` rules
  for anything that must never run.

## Development

From the repository root:

```sh
pnpm install
pnpm run check   # lint, format check, typecheck, Effect diagnostics, tests
```

The root `AGENTS.md` describes the shared lint and compiler policy.

`src/vendor/codex/` contains Apache-2.0 text from
[openai/codex](https://github.com/openai/codex); its `LICENSE`, `NOTICE`, and
`UPSTREAM.md` describe the copy and how to update it.
