# 05: Reject header-unsafe access tokens

**What to build:** Credentials that cannot safely form an authorization header
are rejected where they enter oc-auth, rather than being accepted and later
throwing during model-request construction. The review reproduced a token
containing a newline passing validation and failing header construction.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Apply consistent access-token transport validation to credentials read
      from stores, returned by the token endpoint, and decoded from the host.
- [ ] Reject line breaks and other values the actual header transport cannot
      represent. Do not trim, rewrite, or otherwise repair token material, and
      do not require a vendor-specific token prefix.
- [ ] Preserve the distinction between access-token transport requirements and
      refresh-token requirements; refresh tokens are not authorization headers.
- [ ] Invalid input reaches an actionable, safe boundary outcome instead of an
      uncaught header-construction defect. No diagnostic quotes a token.
- [ ] Regression tests cover unsafe characters at each untrusted entry point and
      a valid synthetic credential reaching request construction unchanged.
- [ ] Run the repository checks and update credential-validation documentation.

## Coordination

Original codebase-review ticket 08 validates user-configured header options.
This follow-up covers credential material, not those already separate options.
