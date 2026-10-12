# Bundled plugins with private libraries

Each plugin is bundled into `dist/`, and code that more than one plugin needs
lives in a private library under `libs/`, which the bundle includes. Libraries
are never published, so sharing code adds no package to release, and each plugin
still ships as one npm package. Only libraries are bundled in. A plugin's
declared dependencies and peer dependencies, the host's own packages among them,
stay external: npm installs them, or the host supplies them.

## Considered options

- **Ship TypeScript source, as OpenCode's plugin docs show.** Rejected: shared
  code would then have to be published as packages of its own.
- **Compile with `tsc`, unbundled, and publish the shared code.** Rejected:
  every shared change becomes another package to version and release.
- **Keep copying shared files between plugins.** Rejected: copies drift.
  oc-auth's and oc-browser's copies of the debug log had already diverged.
