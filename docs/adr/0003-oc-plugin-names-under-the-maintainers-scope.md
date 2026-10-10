# oc- plugin names under the maintainer's npm scope

Every plugin has one plugin name of the form `oc-<word>` (oc-auth,
oc-browser, oc-advisor, oc-auto), written the same way in docs, logs, and
UI. Every other identifier follows from it: the npm name
`@martinthommesen/<name>`, the folder, the plugin IDs
`martinthommesen.<name>` and `martinthommesen.<name>.cli`, command names,
`OC_<WORD>_` environment variables, release tags, and PR scopes. The scope
means no one else can take a plugin's name, or the name of a plugin's extra
packages, before it is published.

## Considered options

- **Unscoped names**, such as `oc-auth`: the shortest config entries, but
  anyone can take a future name first, and a plugin's extra packages need
  an npm org of their own.
- **`@owner/opencode-<name>`**, the most common pattern among OpenCode
  plugins: descriptive, but long.
- **A shared npm org**: `@oplugins` and `@oc-plugins` already existed, and
  creating another needs a passkey sign-in.

## Consequences

- A plugin name says little about the service it works with: oc-auth signs
  in with Claude Code credentials, and oc-auto reviews permission prompts.
  An auth plugin for another service needs a different name.
