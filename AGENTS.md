# oPlugins

A pnpm monorepo of OpenCode v2 plugins, each an Effect plugin in its own
package under `packages/`. Each package's `AGENTS.md` and `README.md`
describe what it does.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

The OpenCode host supplies `effect` to plugins at runtime, so `effect` and
its platform packages are pinned in the `pnpm-workspace.yaml` catalog to the
exact version `@opencode/plugin` depends on. Code against that version's
source, not newer docs: for example, errors are `Schema.TaggedError`, not
`Schema.TaggedErrorClass`.

# Done means green

A change is done when this passes with zero diagnostics from the repository
root:

```sh
pnpm run check   # lint, typecheck, lint:effect, test for every package
```

- `pnpm run lint`: Oxlint (every plugin and category, type-aware, plus the
  vendored anti-slop rules) and `oxfmt --check`, once for the whole
  repository, from the root `.oxlintrc.json` and `.oxfmtrc.json`.
- `pnpm run typecheck`: `tsc` in every package. Each package's
  `tsconfig.json` extends `tsconfig.base.json`.
- `pnpm run lint:effect`: the `@effect/language-service` diagnostics in every
  package, every diagnostic at error (configured in `tsconfig.base.json`).
- `pnpm run test`: Vitest in every package.

There is one lint and compiler policy for the whole repository. Packages do
not carry their own lint, format, or compiler strictness settings. Satisfy a
rule by changing the code. Do not weaken rule severity, add disable
comments, or launder types with casts to make a check pass. Adding any
suppression, option, or `off` is a policy change for the maintainer, not a
fix.

# Vendored code

`tools/oxlint/anti-slop/` is vendored lint tooling shared by every package;
provenance is in its `UPSTREAM.md`. Update it with the `install-anti-slop`
skill, not by hand.
