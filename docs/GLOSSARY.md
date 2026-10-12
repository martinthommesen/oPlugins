# oc-plugins

oc-plugins holds every OpenCode plugin the maintainer builds. These terms
are shared by all of them.

## Language

### Plugins

**Plugin**:
One product in oc-plugins, such as oc-auth or oc-browser, released under
one name.
_Avoid_: package (for the product), extension (for a plugin), add-on

**Plugin name**:
The `oc-` name of a plugin, written the same way everywhere; every other
identifier of the plugin follows from it.
_Avoid_: slug, display name, package name (for the plugin name)

**Server plugin**:
The part of a plugin that runs in OpenCode's server.
_Avoid_: backend, plugin (for the part)

**CLI plugin**:
The part of a plugin that runs in OpenCode's terminal interface.
_Avoid_: TUI plugin, terminal plugin, frontend

**Host**:
OpenCode, the program that loads plugins and runs them.
_Avoid_: runtime (for OpenCode), app (for OpenCode), OpenCode server (for
the loader)

**Option**:
A value the user sets for a plugin in `opencode.jsonc`.
_Avoid_: config value, setting (for an option)

**Library**:
Shared code used by plugins or repository tooling, never released on its own.
_Avoid_: shared package, kit, utils, common (for a library)

**Bundled library**:
A library whose code is built into a plugin's published bundle. Bundling
relates a library to one plugin: a library can be bundled into one plugin
and used only by another plugin's tests.
_Avoid_: production library, runtime library

**Fingerprint**:
A digest of the libraries bundled into a plugin, committed in the plugin's
folder. A library change changes the fingerprint of every plugin it's
bundled into, which is how a library change releases those plugins.
_Avoid_: hash, checksum, lockfile (for a fingerprint)

### Sessions

**Root session**:
The session at the top of an OpenCode session tree, the one the user talks
to.
_Avoid_: parent session, main session, root conversation

**Subagent session**:
A session an agent started to hand part of its task to a subagent. It
belongs to the tree of one root session.
_Avoid_: child session, sub-session

**Transcript**:
A session's conversation written out as text for another model to read.
_Avoid_: history, log, context (for the text)
