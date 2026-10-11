import { Array as Arr, Effect, Schema, SchemaIssue } from "effect"
import type { PluginOptions } from "@opencode/plugin/options"
import PluginOptionsError from "./plugin-options-error.ts"

/*
 * A decoder of `plugin`'s options, as the host hands them over, with the
 * schema `options`. It reports every problem at once, so a typo cannot pass
 * unnoticed.
 */
const decode = <Options extends Schema.Struct<Schema.Struct.Fields>>(
  options: Options,
  plugin: string,
): ((
  raw: PluginOptions,
) => Effect.Effect<
  Options["Type"],
  PluginOptionsError,
  Options["DecodingServices"]
>) => {
  const known = Object.keys(options.fields),
    /*
     * Schema skips the excess-property check on a struct with no fields, so
     * this check names each option such a struct does not declare. Decoding
     * to `options` from `Unknown` adds it without rebuilding `options`, so
     * the decoded type stays exact.
     */
    validated = Schema.Unknown.pipe(Schema.decodeTo(options)).check(
      Schema.makeFilter((decoded) =>
        Arr.difference(Object.keys(decoded), known).map((option) => ({
          issue: new SchemaIssue.UnexpectedKey(options.ast),
          path: [option],
        })),
      ),
    )

  return (raw) =>
    Schema.decodeEffect(validated)(raw, {
      errors: "all",
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((failure) =>
        PluginOptionsError.fromIssue(plugin, known, failure.issue),
      ),
    )
}

/** Decoding a plugin's options from the host's plugin context. */
export default Object.freeze({ decode })
