import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Option,
  Record as Rec,
  Redacted,
  Ref,
} from "effect"
import Host from "./host.ts"
import type HostError from "./host-error.ts"
import UsageMeter from "./usage-meter.ts"
import UsageTracker from "./usage-tracker.ts"
import claudeUsage from "./claude-usage.ts"
import codexUsage from "./codex-usage.ts"

type SignIn = Option.Option.Value<
  Effect.Success<ReturnType<Host["Service"]["signIn"]>>
>

type Outcome = Effect.Success<ReturnType<UsageMeter["Service"]["measure"]>>

type Report = Effect.Success<UsageTracker["Service"]["report"]>

/** What the host answers for one integration's connection. */
type Lookup = Effect.Effect<Option.Option<SignIn>, HostError>

/** The meter's answer for each service, by its name. */
type Answers = Readonly<Record<string, Effect.Effect<Outcome>>>

/** The host's answer for each integration's connection, by its ID. */
type Connections = Readonly<Record<string, Lookup>>

/** What the fake host and meter answer, which a test sets, and what they were asked. */
interface Scripted {
  readonly answers: Ref.Ref<Answers>
  readonly connections: Ref.Ref<Connections>
  /** The service each request the meter got went to, oldest first. */
  readonly measured: Ref.Ref<readonly string[]>
}

const NO_SIGN_IN = Effect.succeed(Option.none<SignIn>()),
  PERCENT_USED = 10,
  /** A reading of one window, 10% used. */
  READING = {
    plan: Option.none<string>(),
    windows: [
      {
        label: "5-hour",
        resetsAt: Option.none<number>(),
        usedPercent: Option.some(PERCENT_USED),
      },
    ],
  },
  /* The answer the meter gives without a script: `READING`. */
  READ_ANSWER = Effect.succeed(UsageMeter.Outcome.Read({ reading: READING })),
  SIGNED_IN = Effect.succeedSome({
    accountId: Option.some("account"),
    token: Redacted.make("token"),
  }),
  /* A connection for the account `identity`, whose sign-in grants `access`. */
  connection = (
    identity: string,
    access: Option.Option.Value<Effect.Success<Lookup>>["access"],
  ): Lookup => Effect.succeedSome({ access, identity }),
  /* A host that answers from `connections`. */
  hostOver = (connections: Ref.Ref<Connections>): Host["Service"] =>
    Host.of({
      signIn: (integrationId) =>
        Ref.get(connections).pipe(
          Effect.map(Rec.get(integrationId)),
          Effect.flatMap(Option.getOrElse(() => NO_SIGN_IN)),
        ),
    }),
  /* A meter that records each request in `measured` and answers from `answers`. */
  meterOver = (scripted: Scripted): UsageMeter["Service"] =>
    UsageMeter.of({
      measure: (request) =>
        Ref.update(scripted.measured, Arr.append(request.service)).pipe(
          Effect.andThen(Ref.get(scripted.answers)),
          Effect.map(Rec.get(request.service)),
          Effect.flatMap(Option.getOrElse(() => READ_ANSWER)),
        ),
    }),
  /* A connection with an OAuth sign-in, for the account `identity`. */
  signedIn = (identity: string): Lookup => connection(identity, SIGNED_IN)

/** The fake host's connections and the fake meter's answers, which a test sets. */
class Script extends Context.Service<Script, Scripted>()(
  "@martinthommesen/oc-usage/tracker.test-support/Script",
) {
  public static readonly READING = READING

  /** A tracker of Claude and ChatGPT over a scripted host and meter. Both are connected, and the meter reads `READING`. */
  public static readonly layer: Layer.Layer<Script | UsageTracker> =
    Layer.effectContext(
      Effect.gen(function* script() {
        const scripted = {
            answers: yield* Ref.make<Answers>({}),
            connections: yield* Ref.make<Connections>({
              anthropic: signedIn("claude-a"),
              openai: signedIn("chatgpt-a"),
            }),
            measured: yield* Ref.make<readonly string[]>([]),
          },
          stubbed = Layer.merge(
            Layer.succeed(Host, hostOver(scripted.connections)),
            Layer.succeed(UsageMeter, meterOver(scripted)),
          ),
          tracker = yield* Layer.build(
            UsageTracker.layer([claudeUsage, codexUsage]).pipe(
              Layer.provide(stubbed),
            ),
          )

        return Context.add(tracker, Script, scripted)
      }),
    )

  public static readonly signedIn = signedIn

  public static readonly withAccess = connection

  /** Every subscription's state in the report, in order. */
  public static readonly states = UsageTracker.pipe(
    Effect.flatMap((tracker) => tracker.report),
    Effect.map(
      (report: Report): readonly Report["subscriptions"][number]["state"][] =>
        report.subscriptions.map((subscription) => subscription.state),
    ),
  )

  /* Makes the meter answer `answer` for `service`. */
  public static readonly answer = (
    service: string,
    answer: Effect.Effect<Outcome>,
  ): Effect.Effect<void, never, Script> =>
    Script.pipe(
      Effect.flatMap((script) =>
        Ref.update(script.answers, Rec.set(service, answer)),
      ),
    )

  /* Makes the host answer `lookup` for the connection of `integrationId`. */
  public static readonly connect = (
    integrationId: string,
    lookup: Effect.Effect<Option.Option<SignIn>, HostError>,
  ): Effect.Effect<void, never, Script> =>
    Script.pipe(
      Effect.flatMap((script) =>
        Ref.update(script.connections, Rec.set(integrationId, lookup)),
      ),
    )

  /* How many requests the meter got for `service`. */
  public static readonly countOf = (
    service: string,
  ): Effect.Effect<number, never, Script> =>
    Script.pipe(
      Effect.flatMap((script) => Ref.get(script.measured)),
      Effect.map((all) => all.filter((name) => name === service).length),
    )
}

export default Script
