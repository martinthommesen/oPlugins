import {
  Context,
  Effect,
  Layer,
  Match,
  MutableRef,
  Option,
  Schema,
  Tracer,
} from "effect"
import type { Exit } from "effect"

type Creation = Readonly<
  Pick<
    ConstructorParameters<typeof Tracer.NativeSpan>[typeof FIRST],
    "kind" | "name" | "sampled" | "startTime"
  >
>

const ATTRIBUTES = 2,
  Attributes = Schema.Record(Schema.String, Schema.Json),
  Events = Schema.Array(
    Schema.Tuple([Schema.String, Schema.BigInt, Attributes]),
  ),
  FIRST = 0,
  Snapshot = Schema.Struct({
    attributes: Attributes,
    events: Schema.Array(
      Schema.Struct({ attributes: Attributes, name: Schema.String }),
    ),
    exit: Schema.String,
    name: Schema.String,
  }),
  Snapshots = Schema.Array(Snapshot),
  decodeAttributes = Schema.decodeUnknownEffect(Attributes),
  decodeEvents = Schema.decodeUnknownEffect(Events),
  encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

class CapturedSpans extends Context.Service<
  CapturedSpans,
  {
    readonly records: Effect.Effect<typeof Snapshots.Type>
  }
>()("@martinthommesen/oc-usage/captured-spans.test-support/CapturedSpans") {
  public static readonly layer = Layer.unwrap(
    Effect.sync(() => {
      const kept = MutableRef.make<
          readonly Effect.Effect<typeof Snapshot.Type>[]
        >([]),
        records = Effect.suspend(() => Effect.all(MutableRef.get(kept))),
        tracer = Tracer.make({
          span: (creation: Creation) => {
            const span = new Tracer.NativeSpan({
                annotations: Context.empty(),
                kind: creation.kind,
                links: [],
                name: creation.name,
                parent: Option.none(),
                sampled: creation.sampled,
                startTime: creation.startTime,
              }),
              view = Effect.suspend(() =>
                Effect.all({
                  attributes: decodeAttributes(
                    Object.fromEntries(span.attributes),
                  ),
                  events: decodeEvents(span.events).pipe(
                    Effect.map((events) =>
                      events.map((event) => ({
                        attributes: event[ATTRIBUTES],
                        name: event[FIRST],
                      })),
                    ),
                  ),
                  exit: Match.valueTags(span.status, {
                    Ended: (ended: {
                      readonly exit: Exit.Exit<unknown, unknown>
                    }) => encodeJson(ended.exit),
                    Started: () => Effect.succeed("started"),
                  }),
                  name: Effect.succeed(span.name),
                }),
              ).pipe(Effect.orDie)

            MutableRef.update(kept, (snapshots) => [...snapshots, view])

            return span
          },
        })

      return Layer.merge(
        Layer.succeed(CapturedSpans, CapturedSpans.of({ records })),
        Layer.succeed(Tracer.Tracer, tracer),
      )
    }),
  )
}

export default CapturedSpans
