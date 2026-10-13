# 18: Preserve refresh-lock inspection failure causes

**What to build:** A refresh still refuses to spend a token when ownership is
uncertain, but its diagnostics explain whether the lock was superseded,
disappeared, was malformed, or could not be inspected. Repeated storage errors
must not look only like an ordinary lost lock or unexplained cooldown.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Keep distinct outcomes for expected missing or superseded ownership,
      unreadable lease files, malformed lease content, and failed ticket scans.
- [ ] Uncertain ownership never becomes permission to refresh. Preserve the
      existing conservative treatment of unreadable tickets and failed writes.
- [ ] Warn with safe operation and failure categories when inspection fails,
      retaining redacted details at debug level without recording ticket bodies
      or credential material.
- [ ] Ordinary contention and expected release remain distinguishable from
      storage faults; define a bounded warning repetition policy.
- [ ] Fault-injected tests cover permission and I/O errors, malformed leases,
      expected absence, supersession, and successful ownership checks, asserting
      both safe coordination and useful diagnostic categories.
- [ ] Update lock and logging documentation and run the repository checks.

## Coordination

Original codebase-review tickets 02 and 03 protect unwritten leases and
unreadable tickets. This follow-up must retain those safety guarantees while
preserving the inspection causes they need not previously have reported.
