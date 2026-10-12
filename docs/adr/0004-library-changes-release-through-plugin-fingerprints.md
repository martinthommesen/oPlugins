# Library changes release plugins through fingerprints

release-please releases a plugin only for commits that touch the plugin's own
folder, so a fix in a bundled library would otherwise ship nowhere. Each plugin
therefore commits a fingerprint of the libraries bundled into it, found from the
plugin's published code and the libraries that code imports, and the pre-commit
hook updates it from the staged files. Changing a library thus changes the
fingerprint of every plugin it's bundled into in the same commit. The commit
type still decides whether anything releases. Because the maintainer commits
straight to `main`, the release workflow checks the exact commit before
release-please and blocks it when a fingerprint is stale, and skips it when
`main` has moved past that commit. The tools pin the release-please version the
release action bundles, and an offline test of its release planning shows that a
library change releases exactly the plugins it's bundled into.

## Considered options

- **release-please's `additional-paths` option.** Rejected for now: it exists
  only in an unmerged pull request (googleapis/release-please#2534). Running the
  fork would put unreviewed code in the release path. Revisit once it ships in
  the release action.
- **release-please's `node-workspace` plugin, with libraries as release-please
  packages.** Rejected as of release-please 17.6.0, the version the release
  action bundles: it merges every release into one pull request, and with
  separate pull requests the cascaded releases get no release label, so they're
  never tagged or published (googleapis/release-please#2853). Libraries would
  also gain versions, changelogs, and tags.
- **Changesets.** Rejected for now: it replaces the whole release setup for a
  repository of four plugins. It's the fallback if fingerprints cost too much to
  maintain.
- **Leaving library fixes for each plugin's next release.** Rejected: a library
  fix would ship only by chance.
