# 20: Make concurrency tests synchronize explicitly

**What to build:** Existing credential-refresh and account-switch race tests
establish their intended interleavings through explicit milestones rather than
assuming a fixed number of scheduler yields has advanced background work far
enough. Preserve each original behavior and assertion while making its
preconditions reliable.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Identify yield-count helpers used to establish refresh, switch, and
      reconnect race preconditions, and replace those assumptions with explicit
      reached and release signals supplied by the test fakes.
- [ ] Tests cannot assert a race outcome before the relevant lookup, exchange,
      subscription, or write-back actually reaches the intended milestone.
- [ ] Keep original scenarios and assertions; do not weaken tests, add sleeps,
      enlarge yield counts, or replace real behavior with module mocks.
- [ ] Test-only signals remain scoped to fresh test instances and introduce no
      production API or cross-test state merely for synchronization.
- [ ] The affected tests pass repeatedly and their intended interleavings can be
      understood without depending on scheduler implementation details.
- [ ] Run the repository checks. New regressions in other follow-up tickets
      already belong to those tickets; this work targets existing fragile tests.

## Coordination

Coordinate shared test helpers with follow-up tickets 01, 02, 03, 09, and 17. No
implementation dependency is assumed, and overlapping tests should not be
rewritten concurrently without agreement.
