# @oc-lib/captured-logs

A private, dev-only library: the logger plugin tests read log records from.
oc-auth, oc-auto, and oc-browser use it to check what they log.

- `src/captured-logs.ts` exports the `CapturedLogs` service. Provide
  `CapturedLogs.layer` to a test: it keeps every record, at every level, in
  place of the console logger. `records` reads them all, oldest first, and
  `named(event)` reads the records of one event. A record's `level` is Effect's
  log level name, such as `Info` or `Warn`.
- Import it as `@oc-lib/captured-logs/captured-logs.ts`, only from a plugin's
  `*.test.ts` and `*.test-support.ts` files, so it stays out of the plugin's
  bundle. A plugin depends on it as a devDependency,
  `"@oc-lib/captured-logs": "workspace:*"`.
