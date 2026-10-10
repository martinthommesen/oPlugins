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

The advisor reads the consulting session's whole conversation, including tool
calls and their results, plus an optional question from the agent. It replies
with advice; it cannot run tools.

## Install

Create a plugin file in your global plugins directory that re-exports this
package:

```ts title="~/.config/opencode/plugins/advisor.ts"
export { default } from "/path/to/opencode-advisor/src/index.ts"
```

Use `.opencode/plugins/advisor.ts` in a project instead to enable it for that
project only.

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
- A consultation renders the session's messages as a transcript. It always
  keeps the first user message and as many of the newest entries as fit
  `maxTranscriptChars`, and shortens long tool inputs and results.
- The advisor model answers in a short-lived child session that is removed
  afterwards. Running in a session means provider plugins that hook session
  requests, such as subscription sign-ins, also work for the advisor. The
  plugin replaces that session's system prompt with the advisor's instructions
  and gives it no tools.
- If the advisor cannot answer (no model, timeout, provider error), the agent
  is told why and continues without advice.

## Limitations

- Agents whose tools are restricted to a fixed list, such as the built-in
  `explore` subagent, are only offered the advisor if their configuration
  allows the `advisor` tool.
- The advisor sees the conversation, not the agent's system prompt or the
  files on disk, unless their contents appear in tool results.

## Development

```sh
pnpm install
pnpm run check
```
