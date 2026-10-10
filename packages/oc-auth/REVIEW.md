# Code + Doc Review: opencode-claude-auth (whole codebase)

**Scope:** whole working tree at `081f2b7` (an ancestor of `main`) plus the tool-alias work that became commit `76aa21a` on the `fix/wire-tool-aliases-and-model-betas` branch. It predates commit `9b72bee` (`src/model-config.ts`). Report-only; nothing was changed. 32 findings.

**Status:** the branch that added this report also resolves #15 (one-to-one alias map) and #21 (`ANTHROPIC_BETA_FLAGS` row). A follow-up pass on the same branch resolved #1, #2, #3, #4, #6, #7, #8, #9, #10, #11 (fail-transient kept, with a consecutive-failure ceiling), #12, #13, #14, #16, #19, #20, #22, #23, #24, #25, #27, #28, #29, #32, the `ANTHROPIC_BETA_FLAGS=""` residual, the repository URL mismatch, and the `writeBackCredentials` duplication advisory. #5 was answered by documenting the non-atomic window rather than closing it. Still open: #17, #18, #26, #30, #31, and the remaining residual risks.

**Team:** correctness, security, reliability, performance, testing, maintainability, doc coherence, doc feasibility, plus an independent cross-model adversarial pass through Codex. Project-standards did not run — no `CODING_STANDARDS.md`, `CLAUDE.md`, or `AGENTS.md` in the repo.

**Baseline:** `pnpm run lint` clean, `pnpm test` 117/117 passing, TypeScript strict.

## Triage Groups

| Group                        | Findings                          | Context                                                                             | Preferred Resolution                                                                     | Why                                                                     |
| ---------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Credential-store integrity   | 3, 5, 8, 10                       | The four ways the plugin can lose or corrupt the user's real Claude login           | Apply queue. Do 3 first (it makes the failure visible), then 10, then 5, then 8          | 3 and 10 are contained edits; 5 and 8 change coordination and need care |
| Silent-pass test guards      | 2, 6, 9, 18, 26, 31               | Tests and CI that report green without exercising the code                          | Apply queue. Do 2 first -- without a macOS CI leg, the tests added for 6 still never run | One root cause: the guard reports success it did not earn               |
| README contradicts the code  | 7, 12, 19, 20, 21, 22, 23, 24, 25 | Nine places where a reader following the README gets a different result             | Apply queue, one editing pass                                                            | Same document, no ordering dependency                                   |
| Issue and PR intake          | 1, 16, 17                         | Templates collect the wrong version and omit what a maintainer needs                | Apply queue                                                                              | Three small template edits                                              |
| Plugin lifecycle robustness  | 14, 27, 28, 29                    | Startup discovery, event handling, and teardown each fail open invisibly            | Apply queue. 14 and 27 are the same failure from two ends -- fix 14 first                | Shared theme: an error swallowed into a debug-only log                  |
| Retry policy (DECISION GATE) | 11                                | The fail-transient OAuth classification is deliberate but produces an endless retry | Decide the policy before writing code                                                    | Reversing a documented tradeoff is the maintainer's call                |

## P1 -- High

**#3 -- Refresh reports success when the rotated token was never persisted** -- `src/credentials.ts:617`
_reliability + adversarial-codex (independent cross-model agreement), conf 100_
A token exchange that succeeded but could not be written back is still logged as `refresh_success` and returned as durable. The session keeps working, but on the next restart the plugin reloads the old refresh token — which the successful exchange may already have revoked — and the user is pushed into re-authentication with no explanation.
**Fix:** retry the guarded write once with a freshly read `expectedAccessToken`, and log a distinct `refresh_writeback_failed` event.

**#5 -- Non-atomic compare-and-swap can overwrite a newer credential** -- `src/keychain.ts:557`
_adversarial-codex, conf 100_
`writeBackCredentials` re-reads, compares, then calls `renameSync` — three separate operations. The Claude Code CLI does not take this plugin's refresh lock, so a credential it rotates between the compare and the rename is destroyed. The keychain branch has the same gap between line 614 and 626.
**Fix:** hold the refresh lock across the re-read and the rename, or use a real atomic CAS. If neither is possible, stop calling it a compare-and-swap in the comments.

**#8 -- Stale in-flight refresh poisons a newer credential** -- `src/credentials.ts:638`
_adversarial-codex, conf 75_
`inFlightRefreshes` is keyed by source alone, so a caller holding a newly rotated credential joins a refresh started with the old token. When the old exchange fails terminally, the joiner inherits the rejection and never tries its own valid token — the user is told to re-authenticate while a working credential sits unused. The code already computes a per-generation key (`refreshCredentialKey`) for backoff state, just not for this map.
**Fix:** key `inFlightRefreshes` by source plus generation, or adopt a newer generation before joining.

**#10 -- Keychain write-back forks the credential item when the account lookup fails** -- `src/keychain.ts:613`
_security, conf 75_
`getKeychainAccountName(source) ?? source` falls back to the service name. `add-generic-password` keys on service+account, so a wrong account name creates a **second** Keychain item instead of updating the existing one, and later reads may not return it.
**Fix:** refuse instead of guessing — log and return `"failed"`. Callers already handle that safely.

**#4 -- Synchronous Keychain subprocess blocks the event loop on the request path** -- `src/index.ts:209`
_performance + reliability, conf 100_
The `http.request` hook calls synchronous `deps.adopt` past a 30 s TTL, spawning `/usr/bin/security` through `execFileSync`. Normal cost is ~10 ms, but the 2000 ms timeout is the bound when the Keychain is slow or locked — and the plugin runs inside the OpenCode server, so **every session stalls**, not just the requesting one. The same blocking read runs up to 21 times in the lock-contention wait at `src/credentials.ts:516`.
**Fix:** promisify `execFile` in `readKeychainService`, switch `readCredentialsFile` to `fs/promises`, await `deps.adopt`. Every call site is already async.

**#11 -- Permanent OAuth 4xx becomes an endless retry** -- `src/refresh-backoff.ts:43` -- **DECISION GATE**
_adversarial-codex, conf 75, owner: human_
`classifyRefreshFailure` discards `_status` and treats every error outside a five-member set as transient. That is deliberate (comment at lines 25-30), but a genuinely permanent error — for a subscription plugin, that includes a lapsed subscription — then cycles forever: cooldown, synthetic 429, retry. Nothing escalates repeated transients to terminal, so the user is never told to re-authenticate.
**Two defensible options:** add an explicit retryable-status list (network, 408, 429, 5xx) and treat other 4xx as terminal; or keep fail-transient and add a consecutive-failure ceiling. The first risks a false "re-authenticate" on an unfamiliar code; the second only bounds the current bias.

**#2 -- Darwin-gated Keychain tests never run in CI** -- `.github/workflows/ci.yml:11`
_testing + doc-feasibility, conf 100_
Both workflows run only `ubuntu-latest`, and the one multi-account Keychain test starts with `if (process.platform !== "darwin") return`. It counts as a pass on every PR and release, so a regression in the primary macOS credential path can merge and publish behind a green badge.
**Fix:** add a `macos-latest` matrix leg, and convert the early return to `{ skip: process.platform !== "darwin" }`.

**#6 -- macOS Keychain write-back branch has zero tests** -- `src/keychain.ts:590`
_testing, conf 100_
Every `writeBackCredentials` call in the suite passes source `"file"`. The darwin branch — stale guard, account lookup, re-read comparison, `security add-generic-password` commit — is the code that mutates the user's real credential store, and none of it is exercised. Findings #5 and #10 both live there.
**Fix:** extend the existing fake `security` script to handle `add-generic-password`; the harness already fakes the binary via `OPENCODE_CLAUDE_AUTH_SECURITY_BIN`.

**#9 -- Frozen test clock disables hot-path credential adoption in every test** -- `src/index.test.ts:226`
_testing, conf 75_
The factory sets `now: () => 0` and `sourceCheckedAt` starts at 0, so `now - sourceCheckedAt >= 30000` is never true. The adoption branch inside `http.request` has never run in a test — the same branch finding #4 identifies as blocking.
**Fix:** add a case with a mutable clock; fire, advance past 30 s, fire again, assert the rotated bearer, then assert a third immediate call does not re-invoke `adopt`.

**#1 -- Bug template asks for the registry version, not the installed one** -- `.github/ISSUE_TEMPLATE/bug_report.yml:52`
_doc-feasibility, conf 100_ — `npm view` returns the newest published version, so every report names the wrong one and hides npm-vs-local installs. **Fix:** use `opencode2 plugin list`.

**#7 -- Environment variables need a service restart the README omits** -- `README.md:118`
_doc-feasibility, conf 75_ — Every variable is read inside the long-running service. The README shows a bare `export CLAUDE_CONFIG_DIR=...` and `unset CLAUDE_AUTH_DEBUG` as if immediate. The enable procedure already pairs its export with `opencode2 service restart`; the rest does not. **Fix:** state the rule once under the table.

## P2 -- Moderate

| #   | What & where                                                                       | Why it matters                                                      | Response                                                    | Conf |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- | ---- |
| 12  | Disable-logging step omits the restart -- `README.md:150`                          | `unset` leaves the service logging credential-adjacent diagnostics  | Say the unset needs a restart; each start truncates the log | 100  |
| 13  | Dead export `refreshClaudeCredential` -- `src/credentials.ts:655`                  | Unreachable code in a published `.d.ts`                             | Delete lines 655-661                                        | 100  |
| 14  | One inaccessible Keychain entry aborts all discovery -- `src/keychain.ts:350`      | A locked item hides every other account                             | Catch per service, continue; rethrow only if nothing found  | 100  |
| 15  | Tool alias collision misroutes calls -- `src/transforms.ts:188`                    | `foo` and `Foo` both alias to `mcp_Foo`; the reverse map keeps one  | Build a one-to-one alias map                                | 100  |
| 16  | Bug template omits credential source -- `bug_report.yml:37`                        | Keychain and file paths differ; no repro without knowing which      | Add a required source dropdown                              | 75   |
| 17  | PR checklist omits Node/pnpm prereqs -- `pull_request_template.md:17`              | `pnpm test` fails below Node 22.6; no `engines` field               | State Node 22.6+ and pnpm 10                                | 75   |
| 18  | `pnpm test` exits 0 with zero tests -- `package.json:29`                           | An empty glob passes and `prepublishOnly` accepts it                | Add `--test-coverage-lines=<measured>`                      | 75   |
| 19  | "Anthropic" names vendor and provider -- `README.md:100`                           | Reads as an Anthropic statement; it is about OpenCode's provider    | Name the provider explicitly                                | 75   |
| 20  | Retryable response attributed to expiry -- `README.md:107`                         | It fires on a 401, not expiry                                       | Rewrite around the 401 trigger                              | 75   |
| 21  | `ANTHROPIC_BETA_FLAGS` is not an override -- `README.md:123`                       | Per-model and inbound values are still merged in                    | Correct purpose and default cells                           | 75   |
| 22  | "No account in /connect" cannot fix a Keychain failure -- `README.md:134`          | Sends the user in a loop past the row that helps                    | Point at the debug events                                   | 75   |
| 23  | Host compatibility row gives no command -- `README.md:138`                         | Names two remedies, no way to do either                             | Name `opencode2 upgrade` / `plugin add pkg@version`         | 75   |
| 24  | Compat note pins a version automation never updates -- `README.md:15`              | release-please never rewrites the README                            | Reword to "This release line targets ..."                   | 75   |
| 25  | `CLAUDE_CONFIG_DIR` prose overstates macOS effect -- `README.md:69`                | On macOS it only labels accounts; it does not select credentials    | Split macOS and non-macOS behavior                          | 75   |
| 26  | Lost-lock paths never execute -- `src/credentials.test.ts:55`                      | The test lock always grants and extends                             | Add cases with `extend: () => false`                        | 75   |
| 27  | Keychain failure shown as missing credentials -- `src/index.ts:117`                | A locked Keychain shows the "run `claude`" message that cannot help | Retain and rethrow from `authorize`                         | 75   |
| 28  | `credential.switched` listener never resubscribes -- `src/index.ts:309`            | Account switching silently stops for the service's life             | Re-subscribing loop guarded by the abort signal             | 75   |
| 29  | One rejecting dispose aborts teardown -- `src/index.ts:323`                        | First rejection skips later disposes and `closeLogger`              | Guard each step; `closeLogger` in `finally`                 | 75   |
| 30  | Host beta version hardcoded in four places -- `src/index.ts:53`                    | Pin, error text, smoke test, and assertion can drift                | Export `REQUIRED_HOST_VERSION`                              | 75   |
| 31  | Assertion-free logger test truncates the real home log -- `src/logger.test.ts:101` | Asserts nothing, writes to the developer's actual log               | Point `HOME` at temp dir; assert contents                   | 75   |

## P3 -- Low

| #   | What & where                                     | Why it matters                                | Response                                       | Conf |
| --- | ------------------------------------------------ | --------------------------------------------- | ---------------------------------------------- | ---- |
| 32  | `isMcpOnly` always false -- `src/keychain.ts:74` | The MCP-only path returns before any log call | Log it with `isMcpOnly: true`, or drop the key | 100  |

## Coverage

- **Cross-model pass:** a second, independent model family reviewed the same tree. Its agreement on #3 counts as independent corroboration. It contributed #5, #8, #11, #15, none of which a local reviewer reached.
- **Validation:** 13 P1 candidates; 10 validated, 3 dropped. Dropped: the README multi-account claim (Credential Sources already states the Linux/Windows single-file behavior); the `NOOP_LOCK` degradation (each fallback logs `refresh_lock_error`, the module is documented best-effort, and returning null would stall uncontended refreshes); and the missing bearer host check (the hook is scoped to `providerID: "anthropic"`, so the destination is the user's own configured baseURL).
- Removable surface: ~7 lines from #13.

### Residual risks (selected)

- **Redaction does not match the token format it protects.** `JWT_PATTERN` is `/^eyJ.../`, anchored — Anthropic OAuth tokens are `sk-ant-oat01-...`, so it can never match one. Key-based redaction covers only `accessToken`/`refreshToken`/`x-api-key`. No call site logs a raw token today, so nothing leaks; the control simply would not work if one were added. `README.md:148` also claims broader coverage than the code has. Reached independently by security and doc-coherence.
- **`CLAUDE_AUTH_DEBUG` is a literal path that gets truncated** — pointing it at `~/.claude/.credentials.json` destroys the user's login with no confirmation. The debug log itself is created world-readable while credentials use 0600.
- **Lock coordination degrades to a no-op** on filesystem failure, and `NOOP_LOCK.extend()` returns `true`. Rejected as a finding, but it is why #5 and #8 have no backstop. `defer()` also skips the `ownsTicket()` check that `extend()` performs.
- **`requestStates` is keyed by the exact `Request` object** — a host-side clone silently skips 401 recovery. Tool-name restoration falls back to the session's registered tools, so it survives a clone.
- **`ClaudeAuthTerminalError` escapes the `http.response` hook**; `recoverUnauthorized` calls `deps.refresh` with no try/catch.
- **`ANTHROPIC_BETA_FLAGS=""` drops `oauth-2025-04-20`**, which subscription auth requires (`??` instead of a non-empty check).
- **`computeBackoffMs` clamps `Retry-After` to 60 s by design**, so an hour-long quota window produces roughly 60 endpoint attempts instead of one. Documented tradeoff.
- **Repository URL mismatch:** badges and `package.json` point at `griffinmartin/opencode-claude-auth`; the git remote is `martinthommesen/opencode-claude-auth`. The installed host is `beta-19381` while the pin is `beta-18381`.
- **Unverified Windows support.** Every Windows claim rests on Claude Code writing `~/.claude/.credentials.json` in the shape `parseCredentials` expects; no test or CI leg covers it.
- **`@opencode-ai/plugin` is an exact-pinned runtime dependency** used only for `Plugin.define`; `peerDependencies` may fit better.
- Maintainability advisories: `writeBackCredentials` duplicates its guard and conflict logic across the file and Keychain branches; `src/transforms.ts:93` uses `as unknown as` to write into host state; ten log call sites use three different shapes for the error field; `src/logger.ts` write failures propagate into the refresh path.

### Testing gaps

Keychain exit codes 36/128/44 and timeout; two 401 recovery outcomes; `updateActive`'s conflict branch; the `latest !== raw` re-read check on both write-back branches; `transformContext`'s `!firstUser` fallback; the `!anthropic` catalog guard; partial-capability `assertCapabilities`; any multi-process lock test; `buildSuffixToDirCache` branches; `invalid_scope`; and no CI check that `dist/index.js` imports before publish.

---

## Verdict

**Ready with fixes.** The architecture is sound and unusually well documented for a plugin this size — the tricky parts (ticket-based locking, guarded write-back, SSE-boundary rewriting) carry comments explaining the tradeoff, not just the mechanism. Nothing here blocks the v2 retarget itself.

**Do this first:** the code that writes to the user's real credential store is both the riskiest code in the repo and the only branch with no tests at all. Fix **#2** so macOS CI runs, then **#6** so that branch has coverage — then **#5** and **#10** become safe to change instead of scary.

### Actionable findings

| #     | Sev   | File:line                     | What                                             | Class             | Fix? | Conf   |
| ----- | ----- | ----------------------------- | ------------------------------------------------ | ----------------- | ---- | ------ |
| 2     | P1    | `.github/workflows/ci.yml:11` | Darwin Keychain tests never run in CI            | gated_auto        | yes  | 100    |
| 6     | P1    | `src/keychain.ts:590`         | Keychain write-back branch untested              | gated_auto        | yes  | 100    |
| 3     | P1    | `src/credentials.ts:617`      | Unpersisted token reported as success            | gated_auto        | yes  | 100    |
| 4     | P1    | `src/index.ts:209`            | Sync Keychain subprocess blocks event loop       | manual            | yes  | 100    |
| 5     | P1    | `src/keychain.ts:557`         | Non-atomic CAS can clobber a newer credential    | gated_auto        | yes  | 100    |
| 1     | P1    | `bug_report.yml:52`           | Template asks for registry version               | gated_auto        | yes  | 100    |
| 8     | P1    | `src/credentials.ts:638`      | Stale in-flight refresh poisons newer credential | gated_auto        | yes  | 75     |
| 9     | P1    | `src/index.test.ts:226`       | Frozen clock disables adoption in every test     | gated_auto        | yes  | 75     |
| 10    | P1    | `src/keychain.ts:613`         | Write-back forks the Keychain item               | gated_auto        | yes  | 75     |
| 7     | P1    | `README.md:118`               | Env vars need a restart the README omits         | gated_auto        | yes  | 75     |
| 12-32 | P2/P3 | see tables above              | 21 further findings, all with concrete fixes     | gated_auto/manual | yes  | 75-100 |

**Decision gate (not in the apply queue):** **#11** `src/refresh-backoff.ts:43` — choose the OAuth retry policy before any code change.
