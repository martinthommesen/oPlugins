# 21: Correct remaining documentation guarantees

**What to build:** Remaining release, host-test, and vendor-verification
guidance describes what this checkout actually supports. Keep these
documentation-only corrections separate from behavior guarantees that must
change alongside their implementations.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Library-change release guidance states that a breaking change bumps the
      minor version while a plugin is below 1.0, matching the release policy,
      rather than promising an unconditional major bump.
- [ ] Host-test guidance distinguishes protection of the original credential
      store from all filesystem writes. Account for build output and inherited
      package-manager caches rather than claiming nothing is written outside the
      sandbox.
- [ ] Preserve the documented copied-account, disposable-account, and offline
      safety distinctions; do not broaden the authority to access real accounts
      or weaken the copied-account refresh protection.
- [ ] Repository-owned vendor provenance guidance identifies inherited test
      paths and verification commands that exist only upstream. Do not edit
      vendored tooling or invent local commands to match those instructions.
- [ ] Cross-check the corrected claims against release configuration, command
      scripts, and provenance records. Validate local links and formatting.
- [ ] Leave expiry-waiting, consultation deadlines, shutdown, and logging docs
      to the behavior tickets that change those guarantees. Run applicable
      repository checks without invoking live host or credential tests.

## Coordination

Original codebase-review tickets 11 and 21 cover copied-account safeguards and
earlier documentation corrections. Preserve their work and scope; these are the
additional inaccuracies found by the latest review, not replacements for those
tickets.
