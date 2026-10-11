import { Context, Deferred, Effect, Layer, Ref } from "effect"

/** What a scripted session API was asked to do. */
class SessionRecord extends Context.Service<
  SessionRecord,
  {
    /** Completes once a consultation asks the advisor model to generate. */
    readonly begun: Deferred.Deferred<boolean>
    /** The sessions it was asked to remove, oldest first. */
    readonly removals: Ref.Ref<readonly string[]>
  }
>()("@martinthommesen/oc-advisor/session-record.test-support/SessionRecord") {
  /** A record of a session API that has not been asked anything yet. */
  public static readonly layer: Layer.Layer<SessionRecord> = Layer.effect(
    SessionRecord,
    Effect.gen(function* emptyRecord() {
      return SessionRecord.of({
        begun: yield* Deferred.make<boolean>(),
        removals: yield* Ref.make<readonly string[]>([]),
      })
    }),
  )
}

export default SessionRecord
