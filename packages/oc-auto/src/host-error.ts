import { Effect, Schema } from "effect"
import hostFailure from "./host-failure.ts"

/** A call to the host through the plugin context failed. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class HostError extends Schema.TaggedError<HostError>()("HostError", {
  /** Why the host call failed, as far as the host's failure says. */
  category: hostFailure.Category,
  /** What the host call failed with. It may quote the conversation. */
  cause: Schema.Defect(),
  operation: Schema.String,
}) {
  /*
   * Maps any failure of a host call to a `HostError` that names the
   * operation and the failure's category.
   */
  public static readonly during =
    (operation: string) =>
    <Value, Failure, Requirements>(
      self: Effect.Effect<Value, Failure, Requirements>,
    ): Effect.Effect<Value, HostError, Requirements> =>
      Effect.mapError(self, (cause) =>
        HostError.make({
          category: hostFailure.categorize(cause),
          cause,
          operation,
        }),
      )
}

export default HostError
