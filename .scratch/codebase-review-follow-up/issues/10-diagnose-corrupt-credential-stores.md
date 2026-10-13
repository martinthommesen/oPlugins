# 10: Distinguish corrupt credentials from absent credentials

**What to build:** A user can tell that a credential store is malformed rather
than being told only that no Claude Code account exists. Legitimately absent
credentials and valid MCP-only data remain ordinary no-credential outcomes.
Healthy fallback stores may still be used, but must not hide corruption in
another store.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Distinguish malformed JSON, malformed credential wrappers, invalid token
      fields, and unusable credential pairs from missing credentials and valid
      data that contains no Claude Code credential pair.
- [ ] Discovery reports a safe category and identifies the affected store
      through approved metadata or redacted details. Provide recovery guidance
      without logging raw blobs, tokens, or decoder messages containing them.
- [ ] Continue offering healthy accounts and permitted fallback stores when one
      store is malformed, with a visible explanation of the degraded result.
- [ ] Guarded write-back still refuses malformed or externally changed data;
      richer parsing outcomes must not relax the guard or overwrite corruption.
- [ ] Tests cover file and Keychain discovery, a healthy fallback, quiet missing
      and MCP-only data, invalid field types, and write-back refusal.
- [ ] Update discovery and logging documentation and run the repository checks.

## Coordination

Follow-up ticket 16 addresses failures to inspect or read accounts and config
directories. This ticket addresses content that was read but is malformed.
