# Every plugin lives in oc-plugins

Every OpenCode plugin the maintainer builds, current or future, is a package in
this repository, and the root docs and checks are its only standards. One lint,
compiler, test, and release setup then serves every plugin, and a change to the
standards reaches all of them in one commit.

## Considered options

- **A repository per plugin, with the standards published as a shared config
  package.** Rejected: each repository pins its own config version and drifts,
  and the vendored lint rules and docs are still copied.
- **A template repository each plugin starts from.** Rejected: a plugin stops
  following the template as soon as it's created.
