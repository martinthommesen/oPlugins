# opencode-auto-review

OpenCode v2 plugin that sends permission prompts to a reviewer model before
they reach you, in the style of Codex's
[Auto-review](https://developers.openai.com/codex/concepts/sandboxing/auto-review).

When a permission rule resolves to **ask**, the plugin shows the reviewer the
conversation and the exact action, and applies its verdict:

- **Allow**: the action runs without a prompt.
- **Deny**: the action is refused. The agent gets the reviewer's reason and
  Codex's instruction to find a materially safer path or stop and ask.
- **Ask**: you get the normal prompt, with a note saying why. This happens
  when the review fails, times out, or keeps denying (see below).

Rules that already resolve to **allow** are not reviewed, and configured
**deny** rules never reach the plugin.

## Requirements

- OpenCode 2.0.26 or newer.
- OpenAI connected with **Sign in with ChatGPT** (`/connect` → OpenAI). The
  reviewer calls the ChatGPT Codex backend with that sign-in. An OpenAI API key
  does not work.

## Install

Add the repository directory to `plugins` in `opencode.jsonc`, globally or per
project:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-auto-review"],
}
```

Auto-review only has work to do when some permission rule asks. OpenCode's
default policy allows most actions, so add `ask` rules for what you want
reviewed, for example every shell command:

```jsonc
{
  "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }],
}
```

## Options

Pass options with the object form of the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/opencode-auto-review",
      "options": { "fallbackModel": "gpt-6-luna", "timeout": "60 seconds" },
    },
  ],
}
```

| Option                  | Default                                 | Meaning                                                                       |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| `model`                 | `codex-auto-review`                     | Reviewer model requested first.                                               |
| `fallbackModel`         | `gpt-5.5`                               | Used once the account turns `model` away. Set it equal to `model` to disable. |
| `reasoningEffort`       | `low`                                   | `minimal`, `low`, `medium`, or `high`.                                        |
| `timeout`               | `90 seconds`                            | Deadline for one review, fallback included.                                   |
| `maxConsecutiveDenials` | `3`                                     | Consecutive denials in one turn before you are asked instead.                 |
| `maxTotalDenials`       | `10`                                    | Total denials in one turn before you are asked instead.                       |
| `extraPolicy`           | (empty)                                 | Text added to the security policy, such as trusted hosts or repositories.     |
| `baseUrl`               | `https://chatgpt.com/backend-api/codex` | Codex Responses backend.                                                      |

Invalid options stop the plugin from loading. OpenCode's log then shows the
error, and permission prompts behave as if the plugin were not installed.

## How it works

- **Reviewer model.** `codex-auto-review` is the hidden model Codex uses for
  Auto-review. OpenAI enables it per account and does not document it, so it
  can change or disappear. When the backend rejects it, the plugin switches to
  `fallbackModel` until the plugin reloads and logs a warning.
- **Policy.** The instructions are Codex's Auto-review policy template and
  default security policy, copied unchanged from the Codex repository (see
  `src/vendor/codex/UPSTREAM.md`). The plugin adds a short section describing
  OpenCode and replaces Codex's output contract with one that says the
  reviewer has no tools.
- **What the reviewer sees.** User messages, the agent's messages and tool
  calls (inputs truncated), conversation summaries, and the planned action:
  the permission request plus the tool call that raised it. Tool outputs are
  left out, so content the agent read cannot address the reviewer directly.
  For a subagent, the reviewer also sees the user's messages from the root
  session, and the subagent's own "user" messages are labeled as coming from
  the delegating agent.
- **Turns and denials.** A turn starts at the newest user message. Like
  Codex, a run of denials (3 in a row, or 10 in total, per turn) hands the
  decision back to you; an approval resets the consecutive count.
- **Failures** (not signed in, expired sign-in, backend errors, timeouts,
  unreadable answers) leave the prompt for you, with the reason in the prompt.

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

```sh
pnpm install
pnpm run check   # lint, format check, typecheck, tests
```

Lint runs every Oxlint plugin and category at error, plus the vendored
anti-slop rules (`tools/oxlint/anti-slop/`). Each rule that is turned off or
configured in `.oxlintrc.json` has its reason next to it.

`src/vendor/codex/` contains Apache-2.0 text from
[openai/codex](https://github.com/openai/codex); its `LICENSE`, `NOTICE`, and
`UPSTREAM.md` describe the copy and how to update it.
