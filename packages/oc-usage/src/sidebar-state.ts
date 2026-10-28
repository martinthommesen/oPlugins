import { Schema } from "effect"

/* Optional recovery information preserves compatibility with the original boolean-only output. */
export default Schema.Struct({
  problem: Schema.optionalKey(Schema.String),
  shown: Schema.Boolean,
})
