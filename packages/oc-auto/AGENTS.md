# oc-auto

OpenCode v2 Effect plugin that sends permission prompts to a reviewer model
before they reach the user. See `README.md` for behavior and options.

The repository root `AGENTS.md` and `LINTING.md` hold the checks, lint
policy, and module shape this package follows.

## Vendored code

`src/vendor/codex/` holds OpenAI Codex's Auto-review policy text
(Apache-2.0). Edit the Markdown files only to take an upstream update, then
run `pnpm run vendor:codex` to regenerate `policy.ts`.
