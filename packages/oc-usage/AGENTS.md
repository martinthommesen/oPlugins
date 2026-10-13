# oc-usage

An OpenCode v2 server plugin (`src/index.ts`, Effect API) and CLI plugin
(`src/tui.ts`) that show the user's Claude and ChatGPT subscription usage
limits. See `README.md` for behavior.

The repository root `AGENTS.md` and `LINTING.md` hold the checks, lint policy,
and module shape this package follows. `GLOSSARY.md` holds the plugin's terms,
and `docs/GLOSSARY.md` the shared ones: use them in code, docs, and messages.

## Design

- Credentials stay in the server plugin. It reads each connection through the
  host's `integration.connection`, which renews an expiring OAuth sign-in, and
  never reads Claude Code's or Codex's credential stores. Nothing it returns,
  logs, or shows carries a token, a header, or a service's response body.
- The server plugin registers the `oc-usage` RPC (`src/usage-rpc.ts`), and the
  CLI plugin calls it. The report travels in its JSON form: the server encodes
  it, and the CLI decodes it with the same schema (`src/usage-report.ts`). The
  sidebar setting lives in the server plugin's storage, so it lasts across
  restarts and is the same in every project, and the `sidebarChanged` event
  tells every CLI when it changes.
- `UsageTracker` (`src/usage-tracker.ts`) keeps each subscription's newest
  attempt by connection identity. It asks a service again only once the
  subscription's interval, or a longer wait the service asked for, has passed,
  and one attempt per subscription runs at a time. A failed attempt keeps an
  earlier measurement with the problem, unless the service refused the sign-in.
- `claude-usage.ts` and `codex-usage.ts` describe each subscription: its
  endpoint, its request headers, and how its answer is decoded. Both endpoints
  are undocumented, so decoding is lenient where a field can be missing, but an
  answer without its main fields is no measurement. A missing share used is
  unknown, never zero.

## Tests

Fake layers stand in for the host, the meter, and the HTTP client
(`*.test-support.ts`); no test reaches a real service. The CLI plugin's tests
(`src/tui.test.ts`) set it up on a fake CLI host with a fake RPC client and
mount its sidebar section in OpenTUI's test renderer, which needs Node 26.1 or
later for `--experimental-ffi`, as oc-auth's do.

`pnpm run test:host` builds the plugin and checks that a headless OpenCode host
starts it. It downloads OpenCode, so it runs in CI and by hand only.
