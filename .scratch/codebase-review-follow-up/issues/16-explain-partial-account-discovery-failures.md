# 16: Explain partial account-discovery failures

**What to build:** Account discovery continues with readable Claude Code
accounts but explains when other accounts or their config-directory mappings
could not be inspected. A partial failure must not silently make accounts or
labels disappear as if they never existed.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Preserve failed per-account reads even when another account succeeds, and
      expose safe normal-level diagnostics for the partial result.
- [ ] Distinguish expected missing files or directories from permission,
      timeout, and other I/O failures during config-directory discovery.
- [ ] Keep readable accounts available and retain approved label fallbacks;
      diagnostics do not turn a recoverable partial failure into total failure.
- [ ] Warnings contain only approved metadata or aggregate failure categories;
      paths and detailed errors stay in redacted debug records. Never log
      credential blobs, tokens, or discovered email content.
- [ ] Tests cover a healthy and failed Keychain account together, inaccessible
      config directories, failed home-directory inspection, and quiet expected
      absence. Specify repetition behavior so discovery cannot flood warnings.
- [ ] Update the discovery and log documentation and run repository checks.

## Coordination

Original codebase-review ticket 18 includes account-label fallback diagnostics;
preserve that behavior rather than duplicating it. Follow-up ticket 10 covers
malformed credential content, whereas this ticket covers inspection and read
failures. They are independently verifiable.
