import { Schema } from "effect"

/** What the layout check reads from the repository. */
const Snapshot = Schema.Struct({
  /** The text of every file the checks read, by its path from the root. */
  files: Schema.Record(Schema.String, Schema.String),
  /** The folders in `libs/`, one per library. */
  libraries: Schema.Array(Schema.String),
  /** The folders in `packages/`, one per plugin. */
  plugins: Schema.Array(Schema.String),
})

export default Snapshot
