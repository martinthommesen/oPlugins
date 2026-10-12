import { Effect, Schema } from "effect"

/** A call to the host through the plugin context failed. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class HostError extends Schema.TaggedError<HostError>()("HostError", {
  cause: Schema.Defect(),
  operation: Schema.String,
}) {
  /* Maps any failure of a host call to a `HostError` that names the operation. */
  public static readonly during =
    (operation: string) =>
    <Value, Failure, Requirements>(
      self: Effect.Effect<Value, Failure, Requirements>,
    ): Effect.Effect<Value, HostError, Requirements> =>
      Effect.mapError(self, (cause) => HostError.make({ cause, operation }))
}

export default HostError
