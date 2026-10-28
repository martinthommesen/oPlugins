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
  sidebar setting lives in the server plugin's storage. CLIs using the same
  server/profile follow `sidebarChanged` and reread storage to recover missed
  events. Malformed storage is hidden with explicit recovery guidance, not a
  successful read of an off setting.
- `UsageTracker` (`src/usage-tracker.ts`) keeps each subscription's newest
  attempt and request reservation by connection identity within one loaded
  location. Labels are display text, not identity. Resolve access before cache
  reuse and after HTTP; retain a measurement only for matching identity and
  token contents. Token comparisons and generation markers stay server-local.
  Minimum waits begin at dispatch and survive interruption and A→B→A switches;
  `Retry-After` begins at response receipt. Budgets in `usage-timeouts.ts` also
  cover permit waiting and credential resolution. A failure retains a verified
  earlier measurement unless the service refused the sign-in.
- The CLI's commands and polling share the sidebar watcher's owning runtime.
  Cleanup gates new work synchronously and interrupts existing work. Directory
  changes and credential events invalidate retained UI reports and late replies.
  Visibility commands report success only after reconciliation succeeds.
- `claude-usage.ts` and `codex-usage.ts` describe each subscription: its
  endpoint, its request headers, and how its answer is decoded. Both endpoints
  are undocumented, so decoding is lenient where a field can be missing, but an
  answer without its main fields is no measurement. A missing share used is
  unknown, never zero. The Codex request follows conventional bearer-token
  authentication; compatibility with native token-sharing sign-ins is
  unverified.

## Tests

Fake layers stand in for the host, the meter, and the HTTP client
(`*.test-support.ts`); no test reaches a real service. The CLI plugin's tests
(`src/tui.test.ts`) set it up on a fake CLI host with a fake RPC client and
mount its sidebar section in OpenTUI's test renderer, which needs Node 26.1 or
later for `--experimental-ffi`, as oc-auth's do.

`pnpm run test:host` builds the plugin and checks that a headless OpenCode host
starts it. It downloads OpenCode, so it runs in CI and by hand only.
