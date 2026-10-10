# oClaude

An OpenCode V2 server plugin (`src/index.ts`, Effect API) and TUI plugin
(`src/tui.ts`) that let OpenCode use Claude Code subscription credentials.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

`effect` is pinned to the exact version the OpenCode host injects at runtime
(see `@opencode/plugin`'s dependency). Code against that version's source, not
newer docs: for example, errors are `Schema.TaggedError`, not
`Schema.TaggedErrorClass`.

# Done means green

A change is done when all of these pass with zero diagnostics:

```sh
pnpm run lint       # oxlint (every rule, type-aware) + oxfmt --check
pnpm run typecheck
pnpm test
```

`.oxlintrc.json` enables every Oxlint rule in every category at its default
options. Its comments list the few deviations and why each exists. Satisfy a
rule by changing the code. Two suppressions are sanctioned, each a proven
contradiction, written exactly as in the file named:

- `unicorn/throw-new-error` on a `Schema.TaggedError` class line: the rule
  mistakes the class factory for a throw (`src/claude-auth-terminal-error.ts`).
- `typescript/prefer-readonly-parameter-types` on the draft parameter of a
  host editor's `update` callback: the host's contract is a draft edited in
  place, which a readonly type cannot express (`src/model-pricing.ts`).

Adding any other suppression, option, or `off` is a policy change for the
maintainer, not a fix.

Before writing code, read `LINTING.md`: the rule set forces an unusual
shape, and that guide is the shortest path to it. Run
`pnpm exec oxlint --fix <files>` first; `require-readable-spacing` and a few
others autofix. Then `pnpm run format`.

# Module shape

The lint policy forces a shape that is unusual but uniform:

- **One default export per file, nothing else exported** (`import/no-named-export`
  covers `export type` too). A file exports one value: a service class, a
  schema, an error class, or a frozen object of pure functions.
- **Types travel through values.** A consumer derives a type from the default
  export it imported: `typeof ClaudeCredentials.Type`, `Credentials["Service"]`,
  `ReturnType<typeof helpers.parse>`. Declare such aliases locally, unexported.
- **One class per file, all files flat in `src/`** (`../` imports are
  banned). Each error class gets its own `*-error.ts` file.
- **Services** are `Context.Service` classes with `static readonly layer`
  (and `layerTest` when tests need a fake), built per the Effect guide:
  `Layer.effect` + `Effect.gen` + `Service.of`, methods via
  `Effect.fn("Service.method")`.
- **Data** is `Schema.Struct`; untrusted input (JSON, files, `security`
  output, host metadata) is decoded with `Schema`, never probed with `typeof`.
  Internal variants are `Data.taggedEnum` and are branched with `$match` or
  `Match`, never by reading `_tag`.

# Platform

The plugin runs inside the OpenCode server, so blocking it stalls every
session. All I/O goes through Effect services, never `node:` modules:
`FileSystem`, `Path`, `ChildProcessSpawner` (`effect/unstable/process`),
`Crypto` (SHA-256 digests, UUIDs), `Encoding` (hex), `Clock`/`DateTime`
(time), `Random`. `src/node-platform.ts` provides the Node
implementations. Environment variables and process facts come from the
`Environment` service (`src/environment.ts`), which tests replace
with `ConfigProvider` or a test layer.

Long-lived state (backoff, in-flight refreshes, the active credential) lives
in `Ref`s owned by a service's layer, so it ends with the plugin's scope.

# Tests

Vitest with `@effect/vitest`: `it.effect`, explicit test layers, `TestClock`
for time, real `FileSystem` against scoped temp directories, and fake
`ChildProcessSpawner` layers in place of the macOS `security` tool. Module
mocking is banned; replace a dependency through its layer.

The original behaviour each test pins is the specification. When porting a
test, keep its scenario and assertion even when its mechanics change.
