# 19: Preserve host-test diagnostic evidence

**What to build:** A failing host test reports problems reading its startup
evidence, manifest, or failure log accurately instead of silently treating them
as missing evidence or bad version configuration. When log extraction fails,
retain recoverable evidence and tell the user where to find it.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Distinguish an expected absent startup marker from permission, I/O, and
      wrong-file-kind failures when reading a marker. Preserve the underlying
      read diagnosis instead of claiming the plugin did not start.
- [ ] Distinguish unreadable manifests, malformed manifest content, missing
      oldest-host configuration, and unsupported version forms, with guidance
      appropriate to each cause.
- [ ] Missing failure logs remain an allowed absence. Other extraction or
      diagnostic-output failures are reported rather than ignored.
- [ ] If extraction fails, do not immediately delete the only recoverable log;
      explain the retained sandbox and cleanup responsibility. Preserve the
      original host-test failure alongside diagnostic failures.
- [ ] Fault-injected tests cover each category, successful cleanup, retained
      evidence, and output failure without live host installation or
      credentials.
- [ ] Keep messages safe, preserve existing command and cleanup deadlines,
      update host-test guidance, and run the repository checks.

## Coordination

Follow-up ticket 12 owns process-release outcomes. This ticket owns the
diagnostic evidence and its storage, not process termination.
