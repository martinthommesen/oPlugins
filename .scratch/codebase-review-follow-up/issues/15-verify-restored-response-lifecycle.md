# 15: Verify restored-response lifecycle behavior

**What to build:** Regression tests establish that restoring tool names in a
model response preserves stream cancellation and failures, not just content and
framing. If the tests expose a defect, repair it within this slice. The review
identified a coverage gap, not a demonstrated stream leak or swallowed failure.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Cancelling a restored response with a nonempty tool-alias map cancels its
      still-open upstream body and does not leave a reader or producer running.
- [ ] An upstream failure before or during content consumption rejects the
      restored stream's consumer rather than appearing as a successful end.
- [ ] Cancellation and failure propagation do not duplicate chunks, corrupt
      framing, or change request-specific tool-alias restoration.
- [ ] Tests use explicitly controlled streams and lifecycle signals, including
      partial chunks and cancellation while waiting for more content, without
      network requests or scheduler-yield guesses.
- [ ] Preserve existing unauthorized-recovery response ownership and release
      behavior. Run the repository checks after tests or necessary fixes.

## Coordination

Original codebase-review tickets 05 and 07 cover request-specific aliases and
unauthorized-recovery response release. This follow-up covers the lifecycle of
the restoration wrapper itself.
