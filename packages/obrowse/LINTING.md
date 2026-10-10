# Lint field guide

How to write code that passes `.oxlintrc.json` the first time. Each entry is
a rule pressure and the shape that satisfies it. The model files are
`src/debug-log.ts`, `src/debug-log-file.ts`, `src/environment.ts`, and
`src/debug-log.test.ts`; copy their shapes.

## Files and exports

- One default export; nothing else is exported, types included. Export a
  frozen object of functions directly: `export default Object.freeze({ a, b })`.
- One class per file. Errors each get a file, written exactly like
  `src/debug-log-path-error.ts`.
- Imports never climb (`../`). Every module lives directly in `src/` or
  `extension/`; test-only helpers are `*.test-support.ts`. Extension code
  reaches a shared module in `src/` as `#src/<file>.ts`.
- `import * as` is banned; Effect platform modules come from the package
  index: `import { NodeFileSystem } from "@effect/platform-node-shared"`.
- Imports are sorted by the first local name, uppercase before lowercase,
  with multi-specifier imports ahead of single ones. Blank lines do not
  separate groups. A type-only symbol from a module that also supplies
  values is a separate `import type` statement.

## Declarations

- One `const` per scope (`one-var`, even across intervening statements),
  and its declarators sorted by name (`sort-vars`), and nothing used before
  it is declared. Together these mean **names must sort in dependency
  order**: choose names so that what a binding uses sorts before it
  (`alert` before `announce` before `formatRecord` before `logTo`).
  Constants in `UPPER_CASE` and schemas in `PascalCase` sort before every
  lowercase name, so they are free.
- In a generator, put every binding in the one `const`, then run the side
  effects. A side effect that must happen between bindings goes into a
  helper or a combinator (`Effect.when`, `Effect.tap`, `.pipe(...)`).
- Every number other than in a constant declaration needs a name, `0` and
  `1` included (`NEXT_LEVEL = 1`, `ONE_ASSERTION = 1`). Bit operations are
  banned; use arithmetic (`mode % 0o1000`).
- Identifiers have at least two characters, type parameters included
  (`Value`, `Failure`). A parameter named `use` trips the React hooks rule.
- No ternaries, no `null`, no `undefined` literal, no `void`, no optional
  chaining, no object spread or rest, no `async`/`await`, no `.then`. Use
  early returns, `Option`, `Match`, `Predicate`, `Object.fromEntries`, and
  Effect. Array spread is fine.
- A host callback that must return a Promise (only the TUI has these) can be
  neither `async` (`oxc/no-async-await`) nor a plain Promise-returning
  function (`typescript/promise-function-async`); annotate it with the
  host's own union return type, such as `false | void | Promise<void>`, and
  return `Effect.runPromise(...)`.
- Functions are arrow expressions (`func-style`). Limits: 10 statements,
  50 lines, 3 parameters, 3 nested calls, depth 4, 300 lines per file.
  Bundle parameters into a readonly struct when there are more than three.

## Comments

- `//` comments are one line each and start with a capital letter (every
  line is checked separately). Multi-line notes are `/* ... */` blocks.
- JSDoc (`/** */`) on a function demands `@param {type}` and `@returns
{type}` for everything, so document functions with `/* */` and keep
  `/** */` for values, classes, and fields. A `/** */` at the head of the
  one `const` statement counts for every function in it, so start that
  statement with a `/* */` or a plain constant.

## Types

- Parameters must be deeply readonly. Effect's data types, Fetch classes,
  and the host's mutable hook events are allowed by the config. Services
  are not: obtain them with `yield*` inside the function, never as
  parameters. Error handlers annotate the parameter with the readonly shape
  they read: `(failure: { readonly message: string }) => ...`.
- The readonly allow list matches type names, so a local alias of an
  allowed type (`type Read = Effect.Effect<string>`) is not allowed; write
  the type inline in parameter positions.
- `oxfmt` lowercases hex digits and `unicorn/number-literal-case` wants
  them uppercase; write such constants in decimal.
- Derive types instead of exporting them: `typeof Schema.Type`,
  `Service["Service"]`, or `typeof fn extends (a: infer A) => object ? A : never`.
- A type and a value cannot share a name (`no-redeclare`), so the
  `Data.TaggedEnum` type and its `Data.taggedEnum` constructors get distinct
  names. Call the constructors directly (`Outcome.Busy({ ... })`); `new-cap`
  accepts PascalCase members of PascalCase owners. A variant with no fields
  cannot be spelled as `{}`; write the union with `_tag` fields by hand and
  pass it to `Data.taggedEnum<Union>()`.
- Avoid Promises inside Effect code entirely: a Promise-returning arrow
  passed to `Effect.promise`/`tryPromise` cannot satisfy both
  `promise-function-async` and `no-async-await`. Prefer Effect APIs
  (`HttpClient`, `FileSystem`, `Stream`) that need no Promise. Where only a
  Web API will do (replaying a `Request` with `fetch`), annotate the thunk
  as returning `PromiseLike`, which is what `tryPromise` asks for and which
  `promise-function-async` does not treat as a Promise:
  `try: (signal): PromiseLike<Response> => fetch(request, { signal })`.
  The extension's `chrome.*` APIs return Promises; wrap them the same way:
  `try: (): PromiseLike<chrome.tabs.Tab[]> => chrome.tabs.query({})`.
- The extension's service worker is the one module with a top-level call:
  `Effect.runFork(program)`, which the `extension/**` override allows.
- An explicit annotation that widens a known value fails
  `no-known-value-widening`; let inference work, or use `satisfies`.

## Effect calls that look like other things

- `Effect.catch(...)` reads as `Promise#catch`; use `Effect.catchTag`,
  `Effect.catchTags`, `Effect.orElse`, or `Effect.orElseSucceed`.
- `Effect.map(self, f)`, `Effect.forEach(self, f)`, and `Option.filter(self, f)`
  read as array methods with a `thisArg`; use the data-last form inside
  `.pipe(...)`. `Sink.forEach` reads as `Array#forEach`; use
  `Sink.forEachArray`.
- Passing a function reference to an iterator method is banned; wrap it:
  `.map((chunk) => textOf(chunk))`.
- `Schema.is(schema)` checks the decoded type; for a JSON string, decode
  with `Schema.decodeUnknownOption(schema)`.

## Tests

- `describe` and each `it.effect` body count as functions: 50 lines and 10
  statements each, so use several small `describe` blocks.
- Every test starts with `expect.hasAssertions()` (`expect.assertions(n)`
  wants a literal, which `no-magic-numbers` forbids), holds at most five
  `expect`s, and asserts booleans with `toBe(true|false)`.
- A plain `it` needs a literal timeout in its options object, where
  `no-magic-numbers` does not look: `it("name", { timeout: 5000 }, () => ...)`.
  `it.effect` is not checked.
- No conditionals in tests, no module mocking, no hooks.
