import { Schema } from "effect"

/* Text a failure may quote, from the conversation or the provider. */
const SECRET = "Transcript: the database password is hunter2",
  /*
   * A model provider's failure, shaped as `AI.Error` from `@opencode/ai`
   * 2.0.27 (`packages/ai/src/schema/errors.ts`): its `reason` is tagged
   * `reason` and quotes the provider's response.
   */
  provider = (
    reason: string,
  ): {
    readonly _tag: "AI.Error"
    readonly reason: {
      readonly _tag: string
      readonly body: string
      readonly message: string
    }
  } =>
    Schema.TaggedStruct("AI.Error", {
      reason: Schema.TaggedStruct(reason, {
        body: Schema.String,
        message: Schema.String,
      }),
    }).make({ reason: { _tag: reason, body: SECRET, message: SECRET } })

/** Model provider failures shaped as OpenCode raises them, quoting `SECRET`. */
export default Object.freeze({ SECRET, provider })
