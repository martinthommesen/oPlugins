# @oc-lib/plugin-options

A private library that decodes a plugin's options from the host's plugin
context. oc-advisor, oc-auth, oc-auto, and oc-browser decode their options with
it when they start.

- `src/plugin-options.ts` exports `decode(options, plugin)`. `options` is a
  `Schema.Struct` of the plugin's options, and `plugin` is the plugin name. It
  returns a function from the host's `context.options` to an effect of the
  decoded options, which fails with `PluginOptionsError` on any problem.
- `src/plugin-options-error.ts` exports `PluginOptionsError`. Its message says
  the plugin didn't start, names every invalid or unknown option, and lists the
  known options for an unknown one. It never quotes a rejected value.
- Import each module by its file, such as
  `@oc-lib/plugin-options/plugin-options.ts`. A plugin depends on the library as
  a devDependency, `"@oc-lib/plugin-options": "workspace:*"`, because the
  plugin's bundle includes it.
- Give each option's schema its default, and an `expected` annotation where
  Schema's own message is unclear. Leave unknown options to `decode`: it rejects
  them, even for a plugin with no options.
