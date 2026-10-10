# opencode-advisor

OpenCode v2 Effect plugin that lets agents consult a configurable advisor
model, like Claude Code's `/advisor`. See `README.md` for behavior and options.

## Checks

Run `pnpm run check` (lint, format check, typecheck, tests) before finishing a
change. Lint runs every Oxlint plugin and category at error plus the vendored
anti-slop rules. Do not weaken rule severity, add disable comments, or launder
types with casts to make a check pass.

## Vendored code

- `tools/oxlint/anti-slop/` is vendored lint tooling; provenance is in its
  `UPSTREAM.md`. Update it with the `install-anti-slop` skill, not by hand.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

The host OpenCode release supplies `effect` at runtime, so the pinned version
follows `@opencode/plugin`'s own `effect` dependency rather than the newest
release. Use APIs that exist in that version.
