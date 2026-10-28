# Changelog

## [0.2.0](https://github.com/martinthommesen/oPlugins/compare/oc-auth-v0.1.0...oc-auth-v0.2.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* plugins now require OpenCode 2.0.27 or newer.
* invalid or unknown plugin options now stop a plugin from starting, and oc-auth reads its settings from options instead of environment variables.
* plugin IDs are now martinthommesen.oc-auth, martinthommesen.oc-auth.cli, martinthommesen.oc-browser, martinthommesen.oc-browser.cli, martinthommesen.oc-advisor, and martinthommesen.oc-auto, so oc-advisor's saved choices reset once. The oc-auth palette command is oc-auth.cache, and OPENCODE_CLAUDE_AUTH_* variables are now OC_AUTH_*.
* the npm package names are now @martinthommesen/oc-auth, @martinthommesen/oc-browser, @martinthommesen/oc-advisor, and @martinthommesen/oc-auto.

### Features

* log only to the host and fail on invalid options ([79ed9fd](https://github.com/martinthommesen/oPlugins/commit/79ed9fd4577515ad9da38e687ffe1b2bb89b36cb))


### Bug Fixes

* **oc-advisor:** run consultations as a hidden consultation agent ([c513c85](https://github.com/martinthommesen/oPlugins/commit/c513c8550eb4bbf98ecfe96659fc0b920038225c))
* **oc-auth:** count a refresh lease only once it's written ([5efaf93](https://github.com/martinthommesen/oPlugins/commit/5efaf9378e701fda00038d53317d319725d466c0))
* **oc-auth:** frame a response's restoration by its content type ([56b54d9](https://github.com/martinthommesen/oPlugins/commit/56b54d956967ad29beded1a853d6aaa37dd43230))
* **oc-auth:** keep credentials out of Keychain process failure records ([2f7dcfe](https://github.com/martinthommesen/oPlugins/commit/2f7dcfe809658d3a769f0a59b9a99804bf1b093e))
* **oc-auth:** keep the active credential in step with the host's selection ([c2e5f71](https://github.com/martinthommesen/oPlugins/commit/c2e5f71b2be0684b7cfbed66842c47dbe43d501f))
* **oc-auth:** log why oc-auth fell back ([6a513e0](https://github.com/martinthommesen/oPlugins/commit/6a513e0ff43af9d93d9c11b66323c1d55226227f))
* **oc-auth:** never let the live host test refresh a copied account ([c5ecf58](https://github.com/martinthommesen/oPlugins/commit/c5ecf5803515701a0161077239dedc1440d39bc5))
* **oc-auth:** never shorten or drop a refresh ticket the lock can't read ([bbbdbe4](https://github.com/martinthommesen/oPlugins/commit/bbbdbe4dc01c37be25ad1ed9154ba47c54044b0a))
* **oc-auth:** reject options that can't be sent as headers ([0af5283](https://github.com/martinthommesen/oPlugins/commit/0af528396309519cc361df073ee0392dee877422))
* **oc-auth:** release recovery responses when interrupted ([c993660](https://github.com/martinthommesen/oPlugins/commit/c993660b916f80bad84345ee9478df4f68fc4269))
* **oc-auth:** report failed credential-file cleanup ([19aafaa](https://github.com/martinthommesen/oPlugins/commit/19aafaa5f055001df7680d5838d1fde6d989c505))
* **oc-auth:** restore each response with its own request's tool aliases ([550181e](https://github.com/martinthommesen/oPlugins/commit/550181ed1c6d37583a59dce004e3c16bffa9cfe5))
* **oc-auth:** restore tool names only in tool-name fields ([d115427](https://github.com/martinthommesen/oPlugins/commit/d1154279e1648f9c5daf4e3853340eeeda6752a4))
* **oc-auth:** stop unauthorized recovery when the turn is cancelled ([c636127](https://github.com/martinthommesen/oPlugins/commit/c636127e4a63e1401181e79819939094d18a8725))
* **release:** release the plugins a library change is bundled into ([cfe0bd0](https://github.com/martinthommesen/oPlugins/commit/cfe0bd0b567a5e36c6af342cbd20fdc81e0606b1))
* trigger v0.5.4 release ([d1f363c](https://github.com/martinthommesen/oPlugins/commit/d1f363c4c7869514a0229b18e38343aac60f745e))


### Code Refactoring

* align plugins with OpenCode 2.0.27 and refine options ([5d3877e](https://github.com/martinthommesen/oPlugins/commit/5d3877ed204885f39781db811535ae92f1a13885))
* give every runtime name the plugin's oc- name ([8e617d7](https://github.com/martinthommesen/oPlugins/commit/8e617d747db1dc61552e3073a38c2b4c0c01d194))
* rename the repo to oc-plugins and the plugins to oc-&lt;word&gt; ([3cd6868](https://github.com/martinthommesen/oPlugins/commit/3cd6868e005fd38d2272922e0639fc09767a55ff))
