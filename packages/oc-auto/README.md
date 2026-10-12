# oc-auto

OpenCode v2 plugin that sends permission prompts to a reviewer model before they
reach you. It reuses the policy and the reviewer model of Codex's
[Auto-review](https://developers.openai.com/codex/concepts/sandboxing/auto-review).

When a permission rule resolves to `ask`, the plugin shows the reviewer the
conversation and the exact action, then settles the request:

- If the reviewer allows the action, it runs without a prompt.
- If the reviewer denies the action, it's refused. The agent gets the reviewer's
  reason and Codex's instruction to find a materially safer path or stop and
  ask.
- Otherwise you get the normal prompt, with a note that says why: the review
  failed, timed out, or lacked context, or the reviewer kept denying.

Requests that a rule already resolves to `allow` or `deny` are left unchanged.

## Install

You need:

- OpenCode 2.0.27 or newer.
- OpenAI connected with "Sign in with ChatGPT". Run `/connect` and choose
  OpenAI. The reviewer uses that sign-in to call the ChatGPT Codex backend. An
  OpenAI API key doesn't work.

oc-auto isn't published to npm yet. Build it from an oc-plugins checkout:

```sh
pnpm install
pnpm --filter @martinthommesen/oc-auto run build
```

Then add the built plugin to `plugins` in `opencode.jsonc`, globally or per
project, and restart OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/oc-plugins/packages/oc-auto/dist"],
}
```

After pulling changes, run the build again. OpenCode loads the new build the
next time it starts.

## Configure

Pass options with the object form of the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/oc-plugins/packages/oc-auto/dist",
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

`timeout` is a string such as `"60 seconds"`, and the denial limits are numbers,
not strings.

An invalid option stops the plugin from loading. That covers a value of the
wrong type, a value out of range, a `reasoningEffort` not in the list, and an
option name not in the table. No invalid option falls back to its default.
OpenCode's log names each invalid option and the problem, and lists the known
options for an unknown name. Until you correct the option and restart OpenCode,
permission prompts behave as if the plugin weren't installed.

Only set `baseUrl` to a backend you trust. It receives your ChatGPT access token
and the conversation. Use HTTPS unless you're testing a local backend. Requests
don't follow redirects.

## Environment variables

oc-auto reads no environment variables. The host test's variables are under
[Verify host compatibility](#verify-host-compatibility).

## How it works

### The reviewer model

`codex-auto-review` is the hidden model Codex uses for Auto-review. OpenAI
enables it per account and doesn't document it, so it can change or disappear.
When the backend rejects it, the plugin logs a warning and uses `fallbackModel`
until the plugin reloads. Other request errors don't select the fallback.

The instructions are Codex's Auto-review policy template and default security
policy, copied unchanged from the Codex repository.
`src/vendor/codex/UPSTREAM.md` records their source. The plugin adds a short
section that describes OpenCode, and replaces Codex's output contract with one
that says the reviewer has no tools.

### What the reviewer sees

The reviewer sees user messages, the agent's messages and tool calls,
conversation summaries, and the planned action. The planned action is the
permission request's action, metadata, and resources, with the exact tool call
that raised it when the request names one. For a request that names no tool
call, the planned action holds only the permission request's fields, and the
reviewer still sees the transcript. Tool outputs are left out. Each transcript
entry quotes its text apart from its speaker label, so a label inside the text
stays part of that entry's text.

For a subagent, the reviewer also sees the user's messages from the root
session, and the subagent's own user messages are labeled as coming from the
delegating agent. If the plugin can't identify the root session, or a request
names the tool call that raised it and the plugin can't find that call, it asks
you instead.

The transcript has a 48,000-character budget. The oldest agent entries are left
out first, and agent text, summaries, and tool inputs in the transcript can be
shortened. Your own messages are never shortened. The planned action has an
8,000-character limit and is never shortened. If either can't fit, the plugin
asks you instead.

### Denial limits

A turn starts at the newest user message in the root session. The root session
and its subagents share one count of denials per turn. With the default limits,
the third denial in a row or the tenth in a turn comes to you as a prompt
instead of going to the agent. An approval resets only the consecutive count, so
once a turn reaches the total limit, every later denial in it comes to you, even
after an approval.

### Failures

Missing or expired sign-ins, backend errors, timeouts, unfinished response
streams, and unreadable answers leave the prompt for you, with the reason. When
a request to the reviewer fails, the prompt and the log name a `category` for
the cause, and the prompt says what to do about it:

| Category           | Cause                                                                     |
| ------------------ | ------------------------------------------------------------------------- |
| `rate_limited`     | The backend answered HTTP 429: it is limiting requests                    |
| `server_error`     | The backend answered an HTTP 5xx status                                   |
| `request_rejected` | The backend answered another HTTP 4xx status                              |
| `network`          | The request didn't reach the backend                                      |
| `invalid_request`  | The plugin couldn't build the request                                     |
| `invalid_response` | The plugin couldn't read the response or one of its stream events         |
| `incomplete`       | The response stream ended before a complete answer                        |
| `response_failed`  | The backend reported in the stream that the response failed               |
| `refused`          | The reviewer refused to answer                                            |
| `output_too_large` | The reviewer's answer exceeded its size limit                             |
| `unknown`          | Nothing structured names the cause; the prompt names the step that failed |

A failed call to OpenCode has a `category` too: `not_found`, `unauthorized`,
`unavailable`, `conflict`, `invalid_request`, or `unknown` when OpenCode's error
names none of those.

### Logs

The plugin logs to OpenCode's log. Records at info level and above carry
metadata only, never the provider's or OpenCode's error text, response bodies,
or the conversation:

| Event                        | Level   | Fields                                                                                                            |
| ---------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `auto_review_verdict`        | Info    | `action`, `verdict`, and `model` when the reviewer decided                                                        |
| `auto_review_failed`         | Warning | `error`, and `model`, `operation`, `category`, `status` (the HTTP status, a number), or `timeout` when they apply |
| `reviewer_model_unavailable` | Warning | `model` and `fallbackModel`                                                                                       |
| `auto_review_rationale`      | Debug   | `action` and the reviewer's `rationale`                                                                           |
| `auto_review_failure_reason` | Debug   | The `reason` the prompt shows                                                                                     |

Debug records pass through redaction first, and OpenCode keeps them only when it
logs at debug level (its `--log-level` flag). Redaction hides recognized tokens,
not every sensitive value. The rationale is model output and can quote the
conversation, so review debug records before you share them.

## Limitations

- Unlike Codex's reviewer, this one can't run read-only commands to inspect
  files before deciding. Its instructions tell it to lean conservative when the
  decision depends on state it can't see.
- The plugin doesn't refresh the ChatGPT sign-in. OpenCode renews it when it
  sends a request to an OpenAI model. Until then, an expired sign-in means
  reviews fall back to asking you.
- Like Codex's Auto-review, this isn't a security boundary. A reviewer can be
  misled, and it only sees actions that reach an `ask` rule. Keep `deny` rules
  for anything that must never run.

## Troubleshooting

| Problem                                         | Action                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The plugin doesn't start                        | Check OpenCode's log, which names each invalid option. Fix the `options` in `opencode.jsonc`, then restart OpenCode.                  |
| The prompt says OpenAI isn't connected          | Run `/connect`, choose OpenAI, and sign in with ChatGPT.                                                                              |
| The prompt says OpenAI uses an API key          | Run `/connect`, choose OpenAI, and sign in with ChatGPT instead.                                                                      |
| The prompt says the ChatGPT sign-in has expired | Send a message with an OpenAI model. OpenCode renews the sign-in when it sends that request.                                          |
| The prompt says the review didn't finish        | Raise `timeout`.                                                                                                                      |
| Every review uses `fallbackModel`               | The backend rejected `model` for your account, as the `reviewer_model_unavailable` warning records. Restart OpenCode to try it again. |
| You want to know why the reviewer decided       | Run OpenCode at debug log level and read the `auto_review_rationale` records.                                                         |

## Development

From the repository root:

```sh
pnpm install
pnpm run check
```

The root `AGENTS.md` lists every check and the shared lint and compiler policy.

To take an upstream update of the vendored Codex policy, follow
`src/vendor/codex/UPSTREAM.md`, then run `pnpm run vendor:codex` in
`packages/oc-auto` to regenerate `policy.ts`.

### Verify host compatibility

Run the commands in this section in `packages/oc-auto`.

Run `pnpm run test:host` to test the packed plugin against the OpenCode version
oc-auto is built against, 2.0.27. The test installs that CLI and the packed
plugin in a temporary directory, with their own config, data, cache, and state
directories, and checks that the host starts the plugin. Installing packages can
require network access.

To check another OpenCode v2 version:

```sh
OC_AUTO_HEADLESS_HOST_VERSION=2.0.27 pnpm run test:host
```

Set it to `oldest` to check the oldest version oc-auto supports, which its
`package.json` records as `engines.opencode`. Set `HEADLESS_KEEP=1` to keep the
sandbox afterwards.

## License

[MIT](LICENSE).

`src/vendor/codex/` holds Apache-2.0 text from
[openai/codex](https://github.com/openai/codex). Its `LICENSE`, `NOTICE`, and
`UPSTREAM.md` describe the copy. The build copies that `LICENSE` and `NOTICE` to
`dist/vendor/codex/`, beside the bundle that includes the text.
