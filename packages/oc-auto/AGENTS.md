# oc-auto

OpenCode v2 Effect plugin that sends permission prompts to a reviewer model
before they reach the user. See `README.md` for behavior and options.

The repository root `AGENTS.md` and `LINTING.md` hold the checks, lint policy,
and module shape this package follows. `GLOSSARY.md` holds the plugin's terms,
and `docs/GLOSSARY.md` the shared ones: use them in code, docs, and messages.

## Failing safe

Every review that cannot decide must leave the request with the user:
`AutoReview.evaluate` turns each failure, including the deadline, into an `ask`
verdict that says why. Keep that path whole when you change what the reviewer
sees, the deadline, failure handling, or the denial breaker, and pin each new
failure mode with a test that expects `ask`.

## Vendored code

`src/vendor/codex/` holds OpenAI Codex's Auto-review policy text (Apache-2.0).
Edit the Markdown files only to take an upstream update, then run
`pnpm run vendor:codex` to regenerate `policy.ts`. `UPSTREAM.md` there records
where each file comes from.
