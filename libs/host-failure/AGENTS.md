# @oc-lib/host-failure

A private library. Its one module, `src/host-failure.ts`, exports `Category`, a
schema of why a call to the host failed, and `categorize`, which gives a host
failure its category. oc-advisor and oc-auto log the category of every failed
host call.

- Import it as `@oc-lib/host-failure/host-failure.ts`. A plugin depends on it as
  a devDependency, `"@oc-lib/host-failure": "workspace:*"`, because the plugin's
  bundle includes it.
- A category comes only from the failure's structured `_tag`, and for a model
  provider's `AI.Error` from its `reason`'s `_tag`; the failure's text is never
  read, because it may quote the conversation. A failure no tag here names is
  `unknown`.
- The plugin context passes on the failures of OpenCode's core services
  unchanged, so the tags are the core's (`Session.NotFoundError`), not the HTTP
  API's (`SessionNotFoundError`). Take a new tag from the host's source for the
  OpenCode version the plugins target, and build test fixtures with its fields.
- Add a new host failure tag or category here, with a test, so every plugin
  names it. A plugin's README lists the categories its log carries; update it
  too.
