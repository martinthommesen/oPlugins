# opencode-advisor

An OpenCode V2 plugin that gives agents an advisor: a second model, usually a
stronger one, that they can consult for a second opinion. It works like Claude
Code's `/advisor`. You pick the advisor model; the agent decides when to ask.

Agents are told to consult the advisor:

- before committing to a plan or approach for non-trivial work, and before big
  or hard-to-reverse decisions;
- when they are stuck: an error keeps recurring, a fix did not work, or results
  contradict expectations;
- before declaring a complex task complete.

The advisor receives a size-limited transcript of the session's current context,
including tool calls and results, plus an optional question from the agent. It
replies with advice and cannot run tools.

## Install

Add the repository directory to `plugins` in `opencode.jsonc`, globally or per
project:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-advisor"],
}
```

## Use

Choose an advisor model with `/advisor`, using the `provider/model` form shown
by `/models`. An optional `#variant` selects a model variant.

```text
/advisor anthropic/claude-opus-5-5#high
```

| Command                       | Effect                                            |
| ----------------------------- | ------------------------------------------------- |
| `/advisor`                    | Show the advisor model and whether it is on       |
| `/advisor <provider/model>`   | Set the advisor model and turn the advisor on     |
| `/advisor on`, `/advisor off` | Turn the advisor on or off, keeping the model     |
| `/advisor subagents on\|off`  | Let subagent sessions consult the advisor, or not |

Choices made with `/advisor` are saved in the plugin's storage and apply to
every session. Replies to `/advisor` appear as messages in the session without
starting a model turn.

You can also ask for a consultation in a prompt, for example "check your plan
with the advisor before you start".

## Options

Options set the defaults that `/advisor` choices override. Pass them with the
object form of a `plugins` entry in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/opencode-advisor",
      "options": { "model": "anthropic/claude-opus-5-5", "subagents": false },
    },
  ],
}
```

| Option               | Default  | Meaning                                                      |
| -------------------- | -------- | ------------------------------------------------------------ |
| `model`              | none     | Advisor model as `provider/model[#variant]`; turns it on     |
| `subagents`          | `true`   | Whether subagent sessions may consult the advisor            |
| `timeout`            | `300`    | Seconds to wait for the advisor before giving up             |
| `maxTranscriptChars` | `200000` | Characters of conversation sent; the newest entries are kept |

Invalid options are logged and replaced by the defaults.

## How it works

- The plugin registers an `advisor` tool. Before each model request it removes
  the tool from sessions that may not use it: when the advisor is off, has no
  model, or the session is a subagent's and subagents are not allowed.
- A consultation renders the available messages as a transcript within
  `maxTranscriptChars`. It keeps the first available user message and the
  newest entries. Long messages, tool inputs and results are shortened.
- The advisor model answers in a temporary child session. The plugin deletes
  it in the background so cleanup cannot hold up the consulting agent. Deletion
  gets one retry and a five-second limit. If cleanup still fails, the plugin
  logs a warning. Session generation supports provider plugins that hook
  requests, such as subscription sign-ins. The plugin replaces the child
  session's system prompt with the advisor's instructions and gives it no tools.
- If the advisor cannot answer (no model, timeout, provider error), the agent
  is told why and continues without advice.

## Limitations

- Agents whose tools are restricted to a fixed list, such as the built-in
  `explore` subagent, are only offered the advisor if their configuration
  allows the `advisor` tool.
- The advisor sees the conversation, not the agent's system prompt or the
  files on disk, unless their contents appear in tool results.
- OpenCode 2.0.26 exposes only the active context after compaction to plugins.
  Earlier details survive only if OpenCode includes them in its compaction
  summary. Include important missing details in the consultation question.

## Development

```sh
pnpm install
pnpm run check
```
