# Writing guide

This guide covers all text written by hand in oc-plugins: docs, `AGENTS.md`
files, ADRs, glossaries, code comments, commit and pull request text, messages
users see, and log events. Vendored text and generated changelogs follow their
own sources.

Where this guide is silent, follow the
[Google developer documentation style guide](https://developers.google.com/style).

## Voice

- Use plain words and short sentences, one idea to a sentence.
- Write in the active voice and the present tense.
- Address the reader as "you", and give instructions as commands: "Run
  `pnpm run check`."
- State facts directly. Leave out hedges such as "might" or "perhaps" and hype
  such as "powerful", "seamless", or "simply".
- Use contractions: "don't", "isn't", "can't".
- Use American spelling.

## Names and terms

- Write a plugin name exactly as it is, lowercase and hyphenated, everywhere:
  oc-auth, oc-browser, oc-advisor, oc-auto. In prose it takes no code font.
- Use the terms in [the shared glossary](GLOSSARY.md) and in each plugin's
  `GLOSSARY.md`, and none of the words a glossary lists under _Avoid_ for the
  same meaning.
- Write product names as their makers do: OpenCode, Claude Code, Chrome.
- Put anything a person types or a program reads in code font: commands, paths,
  identifiers, option names, environment variables, and npm package names.

## Markdown

- Give each file one level 1 heading, and write every heading in sentence case.
- Number steps that happen in order. Use bullets for parallel items, and tables
  for reference material such as options.
- Let oxfmt wrap prose at 80 columns. It leaves line breaks alone in glossaries,
  where each line of an entry has its own role, and in `.github/`, where GitHub
  shows every line break in an issue or pull request.
- State each fact in one place and link to it from anywhere else.
- Leave out what the code, a config file, or `--help` already shows.

## Kinds of document

- **README**: for people who use the plugin. Every plugin README has these
  sections, in order: Install, Configure, Environment variables, How it works,
  Limitations, Troubleshooting, Development, and License. A section that doesn't
  apply says so in one line.
- **`AGENTS.md`**: for coding agents. It holds what an agent can't find by
  looking, says what to do rather than what to avoid, and points to longer docs
  with the condition for reading them.
- **ADR**: a short title and one paragraph that states the decision and why. Add
  "Considered options" or "Consequences" only when they carry weight.
- **Glossary**: terms and their meanings, with no implementation detail.

## Code comments

- Give every default export, service method, Schema field, and error class a
  one-line `/** */` comment that says what it is.
- Other comments say why the code is the way it is, not what it does.

## Messages users see

- An error message says what happened and then what to do, and names the option,
  file, or command involved. Write it as a full sentence that ends with a
  period.
- Titles, labels, and toasts are short phrases in sentence case, with no period.

## Log events

A log record's message is a stable `snake_case` event name, such as
`refresh_writeback_failed`. Its details go in annotations. A record at info
level or above carries metadata only, such as counts, durations, and IDs.
Content, such as an error message, goes only in debug records, after the
`@oc-lib/log-redaction` library has redacted it.

## Commits and pull requests

- A pull request title is a Conventional Commits header: `type(scope): subject`.
  CI rejects a title whose type isn't one of the Conventional Commits types.
  - The scope is the plugin or library the change is in, or `deps` for
    dependency updates. Changes across the repository have no scope.
  - The subject starts lowercase, uses the imperative mood, has no closing
    period, and fits in 72 characters.
- The body says what changed and why, in prose. A breaking change ends with a
  `BREAKING CHANGE:` footer that says what users must do.
- Squash merging makes the title and body the commit message, and release-please
  turns titles into changelog entries.
