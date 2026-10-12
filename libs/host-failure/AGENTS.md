# @oc-lib/host-failure

A private library. Its one module, `src/host-failure.ts`, exports `Category`, a
schema of why a call to the host failed, and `categorize`, which gives a host
failure its category. oc-advisor and oc-auto log the category of every failed
host call.

- Import it as `@oc-lib/host-failure/host-failure.ts`. A plugin depends on it as
  a devDependency, `"@oc-lib/host-failure": "workspace:*"`, because the plugin's
  bundle includes it.
- A category comes only from the failure's structured `_tag`; the failure's text
  is never read, because it may quote the conversation. A failure no tag here
  names is `unknown`.
- Add a new host failure tag or category here, with a test, so every plugin
  names it. A plugin's README lists the categories its log carries; update it
  too.
