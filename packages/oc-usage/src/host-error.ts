import { Effect, Schema } from "effect"
import hostFailure from "@oc-lib/host-failure/host-failure.ts"

/** A call to the host through the plugin context failed. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class HostError extends Schema.TaggedError<HostError>()("HostError", {
  /** Why the host call failed, as far as the host's failure says. */
  category: hostFailure.Category,
  /** What the host call failed with. It may quote a credential's metadata. */
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
      ).pipe(
        Effect.catchDefect((cause) =>
          Effect.fail(
            HostError.make({
              category: hostFailure.categorize(cause),
              cause,
              operation,
            }),
          ),
        ),
        Effect.tapError(
          (failure: {
            readonly category: string
            readonly operation: string
          }) =>
            Effect.logWarning("usage_host_failed").pipe(
              Effect.annotateLogs({
                category: failure.category,
                operation: failure.operation,
              }),
            ),
        ),
      )
}

export default HostError
