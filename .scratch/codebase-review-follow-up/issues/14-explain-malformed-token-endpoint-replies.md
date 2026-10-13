# 14: Explain malformed token-endpoint replies

**What to build:** A successful HTTP status with an unusable token response is
reported as an invalid token response, not merely as HTTP 200. Preserve the
transient-failure and cooldown policy while carrying a useful, content-free
cause through repeated failures and eventual user guidance.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Distinguish invalid JSON and invalid or missing token-response fields from
      transport errors, valid grants, and explicit OAuth error replies.
- [ ] Carry a safe invalid-response category through refresh diagnostics,
      cooldown state where relevant, and the exhaustion message.
- [ ] Invalid successful replies remain transient rather than being classified
      as terminal merely because decoding failed.
- [ ] Diagnostics do not include the body, tokens, or decoder details that echo
      response content; normal-level messages remain metadata-only.
- [ ] Tests cover malformed JSON, missing tokens or expiry, invalid fields,
      repeated invalid replies, and recovery when a valid grant later arrives.
- [ ] Keep ordinary OAuth classification and retry-after handling unchanged,
      update the log documentation, and run the repository checks.

## Coordination

Follow-up tickets 05 and 06 may add token-validation failure cases. This ticket
must classify invalid replies generally and does not depend on those specific
validation refinements being implemented first.
