# 13: Confine refresh tokens to the intended endpoint

**What to build:** The token exchange has an explicit redirect policy that does
not forward refresh-token material to an unintended destination. This is
transport hardening and verification: the review identified default redirect
following but did not demonstrate a production token disclosure.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Define and enforce the token endpoint's redirect policy at the actual HTTP
      transport boundary. Do not rely on authorization-header stripping to
      protect refresh tokens contained in the request body.
- [ ] Synthetic cross-origin 307 and 308 redirects cannot cause a destination to
      receive the refresh-token body. Explicitly cover or reject other redirect
      statuses and same-origin redirects according to the policy.
- [ ] Rejected redirects become safe refresh failures using the existing
      cooldown behavior, with no credentials or response bodies in diagnostics.
- [ ] Tests exercise the real Fetch-backed transport behavior through local or
      replaceable endpoints, not only a fake client that returns final replies.
- [ ] Preserve request and response deadlines, cancellation, and suppression of
      tracing headers. Never send real credentials or contact the live endpoint
      in regression tests.
- [ ] Document the policy and run the repository checks.
