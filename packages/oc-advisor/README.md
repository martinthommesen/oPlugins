# oc-advisor

oc-advisor is an OpenCode v2 plugin that gives agents an advisor: a second
model, usually a stronger one, that they can consult for a second opinion. It
works like Claude Code's `/advisor`. You pick the advisor model, and the agent
decides when to ask.

Agents are told to consult the advisor:

- before committing to a plan for non-trivial work, and before big or
  hard-to-reverse decisions;
- when they're stuck: an error keeps recurring, a fix didn't work, or results
  contradict expectations;
- before declaring a complex task complete.

The advisor receives a size-limited transcript of the session's current context,
including tool calls and results, and the agent's question, if it asked one. It
replies with advice and can't run tools.

## Install

oc-advisor isn't published to npm yet. Build it from an oc-plugins checkout:

```sh
pnpm install
pnpm --filter @martinthommesen/oc-advisor run build
```

Then add the built plugin to `plugins` in `opencode.jsonc`, globally or per
project, and restart OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/oc-plugins/packages/oc-advisor/dist"],
}
```

After pulling changes, run the build again. OpenCode loads the new build on its
next start.

## Configure

### The `/advisor` command

Choose an advisor model with `/advisor`, in the `provider/model` form that
`/models` shows. An optional `#variant` selects a model variant.

```text
/advisor anthropic/claude-opus-5-5#high
```

| Command                       | Effect                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `/advisor`                    | Show the advisor model, whether it's on, and whether subagents may consult it |
| `/advisor <provider/model>`   | Set the advisor model and turn the advisor on                                 |
| `/advisor on`, `/advisor off` | Turn the advisor on or off, keeping the model                                 |
| `/advisor subagents on\|off`  | Let subagent sessions consult the advisor, or not                             |

`/advisor` saves your preferences in the plugin's storage. They apply to every
session and override the options. Its replies appear as messages in the session
and don't start a model turn.

You can also ask for a consultation in a prompt, for example "check your plan
with the advisor before you start".

### Options

Options set the defaults that `/advisor` preferences override. Set them in the
object form of a `plugins` entry in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/oc-plugins/packages/oc-advisor/dist",
      "options": { "model": "anthropic/claude-opus-5-5", "subagents": false },
    },
  ],
}
```

| Option               | Default  | Meaning                                                                                        |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `model`              | none     | Advisor model as `provider/model[#variant]`; setting it turns the advisor on                   |
| `subagents`          | `true`   | Boolean. Whether subagent sessions may consult the advisor                                     |
| `timeout`            | `300`    | Integer, at least `1`. Seconds a consultation may take before the agent goes on without advice |
| `maxTranscriptChars` | `200000` | Integer, at least `1000`. Character limit for the transcript sent to the advisor               |

An invalid option stops the plugin from loading. That covers a value of the
wrong type or out of range, a `model` that isn't of the form
`provider/model[#variant]`, and an option name not in the table. No invalid
option is replaced by its default. [Troubleshooting](#troubleshooting) says how
to find and fix one.

## Environment variables

oc-advisor reads no environment variables. The variables of the host
compatibility test are in [Development](#development).

## How it works

- The plugin registers an `advisor` tool. Before each model request, it removes
  the tool from sessions that may not use it: when the advisor is off or has no
  model, or when the session is a subagent's and subagents aren't allowed.
  Sessions whose agent keeps the tool also get a short system-prompt section
  with the consultation rules above. This encourages consultations without being
  asked, but agents still decide when to call the tool.
- A consultation renders the available messages as a transcript within
  `maxTranscriptChars`. It keeps the first available user message and the newest
  entries, and it shortens long messages, tool inputs, and tool results.
- The advisor model answers in a short-lived consultation session, a child of
  the consulting session. The session runs as the consultation agent, a hidden
  agent the plugin registers under the reserved ID `oc-advisor-consultation`.
  The agent carries the advisor's instructions and denies every tool. The plugin
  overwrites any agent you define under that ID.
- The advisor sees its instructions, the transcript, and the instruction text
  OpenCode adds to every session, such as `AGENTS.md` files and OpenCode's
  built-in instructions. It's offered no tools. Because the request runs in a
  session, provider plugins that hook session requests, such as subscription
  sign-ins, apply to it.
- The plugin deletes the consultation session in the background, so the deletion
  can't hold up the agent. A deletion gets one retry and five seconds in total.
  When the plugin stops, it waits for pending deletions for up to those five
  seconds.
- The `timeout` covers the whole consultation, from reading the session to the
  advisor's answer. If the advisor can't answer (no model, timeout, provider
  error), the agent is told why and continues without advice.

## Limitations

- Agents whose tools are restricted to a fixed list, such as the built-in
  `explore` subagent, are only offered the advisor if their configuration allows
  the `advisor` tool.
- The advisor doesn't see the consulting agent's own prompt or the files on
  disk, unless their contents appear in the conversation.
- OpenCode 2.0.26 exposes only the active context after compaction to plugins.
  Earlier details survive only if OpenCode includes them in its compaction
  summary. The tool description asks agents to put missing details in their
  question.

## Troubleshooting

| Problem                            | Action                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The plugin doesn't start           | OpenCode's log names each invalid option and the problem, and lists the known options for an unknown name. Correct the `options`, then restart OpenCode.          |
| Agents never consult the advisor   | Run `/advisor` to check that a model is set and the advisor is on. For a subagent, check that subagents are allowed and that its agent allows the `advisor` tool. |
| The advisor doesn't answer in time | Raise the `timeout` option, or choose a faster advisor model.                                                                                                     |

The plugin writes its log records to OpenCode's log. They carry metadata such as
event names, session IDs, and model IDs, never the conversation, the advice, or
the text of OpenCode's errors. Each of these events is a warning:

| Event                               | Meaning                                                                                                                                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advisor_consultation_failed`       | A consultation gave no advice. `error` names the reason, with the `model` involved, or with the failed `operation` and its `category`                                                                                                                             |
| `advisor_availability_check_failed` | The plugin couldn't tell whether session `sessionID` is a subagent's, so it hid the advisor from that request. `operation` and `category` say which call failed and why                                                                                           |
| `advisor_model_list_failed`         | `/advisor` couldn't list the models to check the one you chose, and told you so. `operation` and `category` say which call failed and why                                                                                                                         |
| `advisor_session_cleanup_failed`    | The plugin couldn't delete the consultation session `sessionID`, titled "Advisor". `reason` is `timeout` when the five seconds ran out, or `retries_exhausted` when both attempts failed, with the last failure's `category`. You can delete the session yourself |
| `advisor_preferences_unreadable`    | A saved `/advisor` preference under `key` couldn't be read and was ignored. Set it again with `/advisor`                                                                                                                                                          |

`category` says why a call to OpenCode failed, as far as OpenCode's error says:

| Category          | OpenCode's error                                                 |
| ----------------- | ---------------------------------------------------------------- |
| `not_found`       | The session, message, agent, provider, or location doesn't exist |
| `unauthorized`    | The call was refused                                             |
| `unavailable`     | A service OpenCode needs is unavailable                          |
| `conflict`        | The session is busy, or the call conflicts with its state        |
| `invalid_request` | OpenCode rejected the call as invalid                            |
| `unknown`         | The error names none of the causes above                         |

## Development

From the repository root:

```sh
pnpm install
pnpm run check
```

### Verify host compatibility

Run `pnpm run test:host` to test the packed plugin against OpenCode 2.0.27. The
test installs the pinned CLI and the packed plugin in a temporary directory,
with their own config, data, cache, and state directories, and checks that the
host starts the plugin. Package installation may require network access.

To check another v2 host version:

```sh
OC_ADVISOR_HEADLESS_HOST_VERSION=2.0.27 pnpm run test:host
```

Set it to `oldest` to check the oldest version oc-advisor supports, which its
`package.json` records as `engines.opencode`.

Set `HEADLESS_KEEP=1` to keep the sandbox afterwards.

## License

[MIT](LICENSE)
