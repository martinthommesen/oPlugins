import { Effect, Schema } from "effect"

/** A call to the OpenCode server through the plugin context failed. */
class HostError extends Schema.TaggedError<HostError>()("HostError", {
  cause: Schema.Defect(),
  operation: Schema.String,
}) {}

/**
 * Maps any failure of a host call to a `HostError` naming the operation.
 * @param {string} operation The host operation's name.
 * @returns {Function} A pipeline step that replaces the call's error.
 */
const hostError =
  (operation: string) =>
  <Value, Failure, Requirements>(
    self: Effect.Effect<Value, Failure, Requirements>,
  ): Effect.Effect<Value, HostError, Requirements> =>
    Effect.mapError(self, (cause) => new HostError({ cause, operation }))

export { HostError, hostError }
