import { Context, Deferred, Effect, Layer, Ref } from "effect"

/** What a scripted session API was asked to do. */
class SessionRecord extends Context.Service<
  SessionRecord,
  {
    /** Completes once a consultation asks the advisor model to generate. */
    readonly begun: Deferred.Deferred<boolean>
    /** What each session it was asked to create was created with, in order. */
    readonly creations: Ref.Ref<readonly unknown[]>
    /** The sessions it removed, oldest first. */
    readonly deletions: Ref.Ref<readonly string[]>
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
        creations: yield* Ref.make<readonly unknown[]>([]),
        deletions: yield* Ref.make<readonly string[]>([]),
        removals: yield* Ref.make<readonly string[]>([]),
      })
    }),
  )
}

export default SessionRecord
