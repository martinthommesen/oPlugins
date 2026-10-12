# oc-plugins

A pnpm monorepo of OpenCode v2 plugins, each an Effect plugin in its own package
under `packages/`. Code that more than one plugin needs lives in a private
library under `libs/`, and `tools/` holds the repository's own checks. Each
package's `AGENTS.md` and `README.md` describe what it does. `docs/adr/` records
the decisions behind this layout.

# Learning more about Effect

This repository uses the Effect TypeScript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect APIs and concepts that the
guide doesn't cover, search through the source code in
`node_modules/effect/src`.

The OpenCode host supplies `effect` to plugins at runtime, so `effect` and its
platform packages are pinned in the `pnpm-workspace.yaml` catalog to the exact
version `@opencode/plugin` depends on. Code against that version's source, not
newer docs: for example, errors are `Schema.TaggedError`, not
`Schema.TaggedErrorClass`.

# Done means green

A change is done when this passes with zero diagnostics from the repository
root:

```sh
pnpm run check   # every check below, in order, stopping at the first failure
```

- `pnpm run lint`: Oxlint (every plugin and category, type-aware, plus the
  vendored anti-slop rules) and `oxfmt --check`, once for the whole repository,
  from the root `.oxlintrc.json` and `.oxfmtrc.json`. Both run on the paths the
  `format` script lists; add a new top-level file there.
- `pnpm run typecheck`: `tsc` in every package. Each package's `tsconfig.json`
  extends `tsconfig.base.json`.
- `pnpm run lint:effect`: the `@effect/language-service` diagnostics in every
  package, every diagnostic at error (configured in `tsconfig.base.json`).
- `pnpm run test`: Vitest in every package.
- `pnpm run build`, then `pnpm run verify:dist`: each plugin's bundle, and a
  check that it loads.
- `pnpm run pack:dry-run` and `pnpm run publint`: each plugin's package as npm
  would publish it.
- `pnpm run knip`: unused files, exports, and dependencies, configured in
  `knip.jsonc`.
- `pnpm run sherif`: the workspace's `package.json` files agree.
- `pnpm run check:layout`: `tools/check-layout.ts`, which checks that every
  plugin and library is named and wired as the ADRs and this file say, and that
  no other suppression comment exists.

`pnpm run secrets` scans the files for secrets with gitleaks, from
`.gitleaks.toml`; install gitleaks with `brew install gitleaks`. `pnpm install`
installs a pre-commit hook (`lefthook.yml`) that fixes and formats the staged
files and scans them for secrets.

`pnpm run test:host` in a plugin downloads OpenCode, so it runs in CI and by
hand only. Each plugin records the oldest OpenCode version it supports once, as
`engines.opencode` in its `package.json`; set its
`OC_<WORD>_HEADLESS_HOST_VERSION` to `oldest` to test on that version.

There is one lint and compiler policy for the whole repository; packages do not
carry their own lint, format, or compiler strictness settings. `.oxlintrc.json`
enables every Oxlint rule in every category at its default options, and its
comments list the few deviations and why each exists. Satisfy a rule by changing
the code. Do not weaken rule severity, add disable comments, or launder types
with casts to make a check pass. Two suppressions are sanctioned, each a proven
contradiction, written exactly as in the file named:

- `unicorn/throw-new-error` on a `Schema.TaggedError` class line: the rule
  mistakes the class factory for a throw
  (`packages/oc-auth/src/claude-auth-terminal-error.ts`).
- `typescript/prefer-readonly-parameter-types` on the draft parameter of a host
  editor's `update` callback: the host's contract is a draft edited in place,
  which a readonly type cannot express
  (`packages/oc-auth/src/model-pricing.ts`).

Adding any other suppression, option, or `off` is a policy change for the
maintainer, not a fix.

Before writing code, read `LINTING.md`: the rule set forces an unusual shape,
and that guide is the shortest path to it. Run `pnpm exec oxlint --fix <files>`
first; `require-readable-spacing` and a few others autofix. Then
`pnpm run format`.

# Module shape

The lint policy forces a shape that is unusual but uniform:

- **One default export per file, nothing else exported**
  (`import/no-named-export` covers `export type` too). A file exports one value:
  a service class, a schema, an error class, or a frozen object of pure
  functions.
- **Types travel through values.** A consumer derives a type from the default
  export it imported: `typeof ClaudeCredentials.Type`, `Credentials["Service"]`,
  `ReturnType<typeof helpers.parse>`. Declare such aliases locally, unexported.
- **One class per file, all files flat in the package's `src/`** (`../` imports
  are banned; oc-browser's Chrome extension is flat in its own `extension/`).
  Each error class gets its own `*-error.ts` file.
- **Services** are `Context.Service` classes with `static readonly layer` (and
  `layerTest` when tests need a fake), built per the Effect guide:
  `Layer.effect` + `Effect.gen` + `Service.of`, methods via
  `Effect.fn("Service.method")`.
- **Data** is `Schema.Struct`; untrusted input (JSON, files, process output,
  host metadata) is decoded with `Schema`, never probed with `typeof`. Internal
  variants are `Data.taggedEnum` and are branched with `$match` or `Match`,
  never by reading `_tag`.

# Platform

Plugins run inside the OpenCode server, so blocking one stalls every session.
All I/O goes through Effect services, never `node:` modules: `FileSystem`,
`Path`, `ChildProcessSpawner` (`effect/unstable/process`), `HttpClient`,
`Crypto`, `Encoding`, `Clock`/`DateTime` (time), `Random`. Environment variables
and process facts come from a service that tests replace with `ConfigProvider`
or a test layer.

Long-lived state lives in `Ref`s owned by a service's layer, so it ends with the
plugin's scope.

# Tests

Vitest with `@effect/vitest`: `it.effect`, explicit test layers, `TestClock` for
time, and real `FileSystem` against scoped temp directories. Module mocking is
banned; replace a dependency through its layer.

The original behavior each test pins is the specification. When porting a test,
keep its scenario and assertion even when its mechanics change.

# Vendored code

`tools/oxlint/anti-slop/` is vendored lint tooling shared by every package;
provenance is in its `UPSTREAM.md`. Update it with the `install-anti-slop`
skill, not by hand.
