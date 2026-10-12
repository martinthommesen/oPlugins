# @oc-lib/log-redaction

A private library. Its one module, `src/log-redaction.ts`, exports `redact`,
which hides known secrets in a log record's fields:

- It replaces the value of a field whose name matches one in a fixed list
  exactly, case included. `accessToken` and `authorization` match, and
  `Authorization`, `access_token`, and `apiKey` don't.
- It cuts each recognized token, an Anthropic token (`sk-ant-...`) or a JWT,
  inside a string to its first eight characters. A string that starts with a JWT
  is cut whole.
- It replaces structure nested more than four levels deep with a placeholder.

It doesn't find every secret. Anything else in a field, such as a path, an
account name in free text, or a token of another format, passes through
unchanged. Redaction is a safeguard for content a record already needs, not
permission to log sensitive content.

oc-auth and oc-auto pass every field of a debug record through it. Their debug
records carry content such as error messages, and oc-auto's carry the reviewer's
rationale, which is model output. Before you log content, decide that the record
needs it, whether or not it's redacted.

- Import it as `@oc-lib/log-redaction/log-redaction.ts`. A plugin depends on it
  as a devDependency, `"@oc-lib/log-redaction": "workspace:*"`, because the
  plugin's bundle includes it.
- Add a new secret field name or token format here, with a test, so every plugin
  redacts it.
