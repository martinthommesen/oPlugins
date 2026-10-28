# Changelog

## [0.2.0](https://github.com/martinthommesen/oPlugins/compare/oc-auto-v0.1.0...oc-auto-v0.2.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* plugins now require OpenCode 2.0.27 or newer.
* invalid or unknown plugin options now stop a plugin from starting, and oc-auth reads its settings from options instead of environment variables.
* plugin IDs are now martinthommesen.oc-auth, martinthommesen.oc-auth.cli, martinthommesen.oc-browser, martinthommesen.oc-browser.cli, martinthommesen.oc-advisor, and martinthommesen.oc-auto, so oc-advisor's saved choices reset once. The oc-auth palette command is oc-auth.cache, and OPENCODE_CLAUDE_AUTH_* variables are now OC_AUTH_*.
* the npm package names are now @martinthommesen/oc-auth, @martinthommesen/oc-browser, @martinthommesen/oc-advisor, and @martinthommesen/oc-auto.

### Features

* log only to the host and fail on invalid options ([79ed9fd](https://github.com/martinthommesen/oPlugins/commit/79ed9fd4577515ad9da38e687ffe1b2bb89b36cb))
* **oc-auto:** name the cause of failed review requests and host calls ([9dbd934](https://github.com/martinthommesen/oPlugins/commit/9dbd934a671ce0be11895eaa4069366776b0ae28))


### Bug Fixes

* **host-failure:** match the host's real failure tags ([1cd608e](https://github.com/martinthommesen/oPlugins/commit/1cd608e33c69c0d2495cbd902e882fc5f35437bc))
* **release:** release the plugins a library change is bundled into ([cfe0bd0](https://github.com/martinthommesen/oPlugins/commit/cfe0bd0b567a5e36c6af342cbd20fdc81e0606b1))
* trigger v0.5.4 release ([d1f363c](https://github.com/martinthommesen/oPlugins/commit/d1f363c4c7869514a0229b18e38343aac60f745e))


### Code Refactoring

* align plugins with OpenCode 2.0.27 and refine options ([5d3877e](https://github.com/martinthommesen/oPlugins/commit/5d3877ed204885f39781db811535ae92f1a13885))
* give every runtime name the plugin's oc- name ([8e617d7](https://github.com/martinthommesen/oPlugins/commit/8e617d747db1dc61552e3073a38c2b4c0c01d194))
* rename the repo to oc-plugins and the plugins to oc-&lt;word&gt; ([3cd6868](https://github.com/martinthommesen/oPlugins/commit/3cd6868e005fd38d2272922e0639fc09767a55ff))
