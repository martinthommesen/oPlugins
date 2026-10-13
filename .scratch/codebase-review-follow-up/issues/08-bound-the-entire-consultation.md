# 08: Apply the deadline to the entire consultation

**What to build:** A consultation finishes with advice or a useful failure
within its configured deadline, including time spent loading preferences.
Currently preference reads precede the timed operation and can hold the
consulting session indefinitely.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The consultation deadline starts before preference loading and includes
      availability checks, transcript loading, and obtaining advice.
- [ ] A stalled preference read produces timeout guidance without creating a
      consultation session or leaving unbounded work behind.
- [ ] Existing bounded consultation-session cleanup still runs on timeout,
      failure, and interruption; moving the deadline does not bypass cleanup.
- [ ] Tests use a held preference read and controlled time to verify the exact
      timeout boundary and the absence of a consultation-session creation call.
- [ ] Keep coverage for slow parent lookup, transcript reads, session creation,
      and advice, and verify timely consultations still succeed.
- [ ] Update the whole-consultation timeout guarantee and run the repository
      checks.
