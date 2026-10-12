import { Array as Arr, Deferred, Effect, Layer, Ref, Schema } from "effect"
import Advisor from "./advisor.ts"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import Host from "./host.ts"
import { Model } from "@opencode/plugin/effect"
import type PreferenceStore from "./preference-store.ts"
import { Session } from "@opencode/schema/session"
import SessionRecord from "./session-record.test-support.ts"
import support from "./advisor.test-support.ts"

/** What a scripted host call fails with: text, or a structured failure. */
type Failure = string | { readonly _tag: string; readonly message: string }

type FakeSession = Parameters<
  typeof Host.fromPlugin<Failure>
>[typeof FIRST]["session"]

/** What the tests read of a session creation's input. */
interface Creation {
  readonly agent?: string | undefined
  readonly model?:
    | {
        readonly id: string
        readonly providerID: string
        readonly variant?: string | undefined
      }
    | undefined
  readonly parentID?: string | undefined
  readonly permissions?:
    | readonly {
        readonly action: string
        readonly effect: string
        readonly resource: string
      }[]
    | undefined
  readonly title?: string | undefined
}

/** How the host's session API answers; unscripted calls succeed at once. */
interface Scenario {
  readonly create?: Effect.Effect<void>
  readonly generate?: Effect.Effect<string, Failure>
  readonly list?: Effect.Effect<void, Failure>
  readonly parent?: Effect.Effect<void, Failure>
  readonly remove?: Effect.Effect<void, Failure>
  readonly subagents?: boolean
  readonly transcript?: Effect.Effect<readonly never[]>
}

const CHILD_ID = Session.ID.make("ses_advisor_child"),
  CHILD_INFO = Schema.decodeEffect(Session.Info)({
    cost: 0,
    id: CHILD_ID,
    location: { directory: "/advisor-test" },
    parentID: support.SESSION_ID,
    projectID: "project_test",
    time: { created: 0, updated: 0 },
    tokens: { cache: { read: 0, write: 0 }, input: 0, output: 0, reasoning: 0 },
  }),
  FIRST = 0,
  MODEL = Model.Ref.parse("anthropic/claude-opus-5-5"),
  TIMEOUT_SECONDS = 1,
  /* The host's session API as `scenario` scripts it, recording in `record`. */
  apiFor = (
    scenario: Scenario,
    child: Session.Info,
    record: SessionRecord["Service"],
  ): FakeSession => ({
    context: () => scenario.transcript ?? Effect.succeed([]),
    create: (input?: Creation) =>
      Ref.update(record.creations, Arr.append(input)).pipe(
        Effect.andThen(scenario.create ?? Effect.void),
        Effect.as(child),
      ),
    generate: () =>
      Deferred.succeed(record.begun, true).pipe(
        Effect.andThen(scenario.generate ?? Effect.succeed("Advice.")),
        Effect.map((text) => ({ text })),
      ),
    get: () => (scenario.parent ?? Effect.void).pipe(Effect.as(child)),
    remove: () => {
      const deleted = Ref.update(record.deletions, Arr.append(CHILD_ID))

      return Ref.update(record.removals, Arr.append(CHILD_ID)).pipe(
        Effect.andThen(scenario.remove ?? Effect.void),
        Effect.andThen(deleted),
      )
    },
    synthetic: () => Effect.die("unexpected notification"),
  }),
  /*
   * The advisor and host on a host scripted by `scenario`, its record, and
   * the logs.
   */
  arrange = (
    scenario: Scenario,
  ): Layer.Layer<
    Advisor | CapturedLogs | Host | PreferenceStore | SessionRecord
  > =>
    support
      .pluginServices(
        Layer.unwrap(
          Effect.gen(function* scriptedHost() {
            const child = yield* Effect.orDie(CHILD_INFO),
              record = yield* SessionRecord

            return Host.fromPlugin({
              model: {
                list: () =>
                  (scenario.list ?? Effect.void).pipe(
                    Effect.as({ data: [], location: child.location }),
                  ),
              },
              session: apiFor(scenario, child, record),
            })
          }),
        ).pipe(Layer.provideMerge(SessionRecord.layer)),
        {
          model: "anthropic/claude-opus-5-5",
          subagents: scenario.subagents ?? true,
          timeout: TIMEOUT_SECONDS,
        },
      )
      .pipe(Layer.orDie, Layer.merge(CapturedLogs.layer)),
  /** The block's advisor and host, and what the host's session API was asked. */
  arranged = Effect.gen(function* arranged() {
    const record = yield* SessionRecord

    return {
      advisor: yield* Advisor,
      begun: record.begun,
      creations: record.creations,
      deletions: record.deletions,
      host: yield* Host,
      removals: record.removals,
    }
  })

/** A host whose session API answers from a script, and its record. */
export default Object.freeze({
  CHILD_ID,
  MODEL,
  TIMEOUT_SECONDS,
  arrange,
  arranged,
})
