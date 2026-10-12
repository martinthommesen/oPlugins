import { Schema } from "effect"

/* A structured host failure tagged `tag`, with text a log must not carry. */
const failure = (
  tag: string,
): { readonly _tag: string; readonly message: string } =>
  Schema.TaggedStruct(tag, { message: Schema.String }).make({
    message: "Transcript: the database password is hunter2",
  })

/** Synthetic host failures. */
export default Object.freeze({ failure })
