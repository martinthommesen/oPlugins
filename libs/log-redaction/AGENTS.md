# @oc-lib/log-redaction

A private library. Its one module, `src/log-redaction.ts`, exports `redact`:
a log record's fields with every secret removed. oc-auth and oc-auto pass
every field of a debug record through it, because a debug record may carry
content such as an error message or a model's answer.

- Import it as `@oc-lib/log-redaction/log-redaction.ts`. A plugin depends on
  it as a devDependency, `"@oc-lib/log-redaction": "workspace:*"`, because
  the plugin's bundle includes it.
- Add a new secret field name or token format here, with a test, so every
  plugin redacts it.
