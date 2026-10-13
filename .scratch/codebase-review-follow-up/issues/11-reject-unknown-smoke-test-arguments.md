# 11: Reject unknown smoke-test arguments

**What to build:** A mistyped smoke-test flag fails immediately rather than
silently choosing a live run. In particular, a misspelling of the offline flag
must not read a real account or send a subscription-consuming model request.
Preserve the documented offline, copied-account, and disposable-account modes.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Validate all command arguments against the supported grammar before
      installation, credential discovery or copying, sandbox work, or network
      activity begins.
- [ ] Unknown flags and unexpected positional arguments fail with the accepted
      modes and a non-successful command outcome; do not silently ignore them.
- [ ] Valid argument forwarding from the documented package-manager commands
      still selects the intended mode. Decide and test duplicate-flag handling.
- [ ] Regression tests use a misspelled offline flag and prove no credential,
      install, or model-request side effect occurs before rejection.
- [ ] Test valid offline and live argument selection with synthetic services; do
      not run live credentials or consume a subscription to verify parsing.
- [ ] Update command usage and run the repository checks.

## Coordination

Original codebase-review ticket 11 protects copied-account refresh tokens. This
follow-up protects mode selection before any account is accessed and must
preserve those copied-account safeguards.
