# 12: Report host-test process cleanup failures

**What to build:** A host-test command does not silently report clean success
when releasing its process fails or exceeds the cleanup deadline. Keep command
and cleanup waiting bounded. The review reproduced a failing release finalizer
being discarded while the command returned successful output.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Inspect process-release completion, failure, and timeout separately rather
      than discarding the release outcome.
- [ ] A successful command whose release fails or cannot be confirmed does not
      masquerade as a fully successful run. Report the cleanup outcome and any
      remaining uncertainty about descendants.
- [ ] If the command itself already failed or timed out, retain its original
      cause and collected output while adding cleanup diagnostics.
- [ ] Keep the existing bounded cleanup allowance, including detached cleanup
      when necessary; do not reintroduce an unbounded finalizer wait.
- [ ] Fake-process tests cover successful release, a failed finalizer, and a
      never-ending release after both successful and failed commands, using
      controlled time and no real process termination.
- [ ] Update the host-test cleanup guarantee and run the repository checks.

## Coordination

Original codebase-review ticket 12 bounds command execution and termination.
This follow-up preserves those bounds while making release outcomes visible.
