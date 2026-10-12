import { Array as Arr, Effect, Schema, SchemaIssue } from "effect"
import type { PluginOptions } from "@opencode/plugin/options"
import PluginOptionsError from "./plugin-options-error.ts"

/*
 * A decoder of `plugin`'s options, as the host passes them, with the schema
 * `options`. It rejects unknown options, so a typo can't go unnoticed, and
 * reports every problem at once.
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
     * this check names each option such a struct doesn't declare. It sits on
     * `Unknown` decoded to `options`, not on `options` itself, so `options`
     * isn't rebuilt and the decoded type stays exact.
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
