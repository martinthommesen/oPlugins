import { Context, Duration, Effect, Layer, Option } from "effect"
import ConsultationTimedOut from "./consultation-timed-out-error.ts"
import Host from "./host.ts"
import type HostError from "./host-error.ts"
import PluginOptions from "./plugin-options.ts"
import PreferenceStore from "./preference-store.ts"
import type { Session } from "@opencode/schema/session"
import availability from "./availability.ts"
import modelRef from "./model-ref.ts"
import prompt from "./prompt.ts"

type Availability = Effect.Success<
  ReturnType<typeof availability.decideAvailability>
>

type Preferences = Effect.Success<PreferenceStore["Service"]["current"]>

/** What the advisor model answered, and which model it was. */
interface Advice {
  readonly model: string
  readonly text: string
}

/*
 * Every reason a consultation can end without advice: the session may not
 * consult the advisor (`AdvisorUnavailable`), its model reference is invalid
 * (`InvalidModel`), a host call failed, or the deadline passed.
 */
type ConsultationError =
  | ConsultationTimedOut
  | HostError
  | Effect.Error<ReturnType<typeof availability.requireModel>>
  | Effect.Error<ReturnType<typeof modelRef.parseModelRef>>

interface Interface {
  /** Whether a session may consult the advisor now, and with which model. */
  readonly availability: (
    sessionId: Session.ID,
  ) => Effect.Effect<Availability, HostError>
  /** Asks the advisor model about a session's conversation. */
  readonly consult: (
    sessionId: Session.ID,
    question: Option.Option<string>,
  ) => Effect.Effect<Advice, ConsultationError>
}

/** The services `consult` uses. */
interface Dependencies {
  readonly host: Host["Service"]
  readonly options: PluginOptions["Service"]
  readonly preferences: PreferenceStore["Service"]
}

/* Whether `sessionId` may consult the advisor under `preferences`. */
const availabilityIn = (
    host: Host["Service"],
    sessionId: Session.ID,
    preferences: Preferences,
  ): Effect.Effect<Availability, HostError> =>
    availability.decideAvailability(
      preferences,
      host.parent(sessionId).pipe(Effect.map(Option.isSome)),
    ),
  /* Fails a consultation of `model` that outlasts its deadline. */
  byDeadline =
    (timeout: Duration.Duration, model: string) =>
    <Value, Failure>(
      self: Effect.Effect<Value, Failure>,
    ): Effect.Effect<Value, Failure | ConsultationTimedOut> =>
      Effect.timeoutOrElse(self, {
        duration: timeout,
        orElse: () =>
          Effect.fail(
            ConsultationTimedOut.make({
              model,
              seconds: Duration.toSeconds(timeout),
            }),
          ),
      }),
  /* Builds `consult` from the services it uses. */
  consultVia = ({
    host,
    options,
    preferences,
  }: Dependencies): Interface["consult"] =>
    Effect.fn("Advisor.consult")(function* consult(
      sessionId: Session.ID,
      question: Option.Option<string>,
    ) {
      const current = yield* preferences.current,
        request = Effect.gen(function* requestAdvice() {
          const advisorModel = yield* availabilityIn(
              host,
              sessionId,
              current,
            ).pipe(Effect.flatMap(availability.requireModel)),
            ref = yield* modelRef.parseModelRef(advisorModel),
            transcript = yield* host.transcript(sessionId)

          return {
            model: advisorModel,
            text: yield* host.consult(
              sessionId,
              prompt.advisorPrompt(
                transcript,
                options.maxTranscriptChars,
                question,
              ),
              ref,
            ),
          }
        })

      return yield* request.pipe(
        byDeadline(
          options.timeout,
          Option.getOrElse(current.model, () => "not configured"),
        ),
      )
    })

/** Consults the configured advisor model about a session's conversation. */
class Advisor extends Context.Service<Advisor, Interface>()(
  "@martinthommesen/oc-advisor/advisor",
) {
  /** The advisor, on the `Host`, `PluginOptions`, and `PreferenceStore` in context. */
  public static readonly layer = Layer.effect(
    Advisor,
    Effect.gen(function* makeAdvisor() {
      const host = yield* Host,
        options = yield* PluginOptions,
        preferences = yield* PreferenceStore

      return Advisor.of({
        availability: Effect.fn("Advisor.availability")(
          function* checkAvailability(sessionId: Session.ID) {
            return yield* availabilityIn(
              host,
              sessionId,
              yield* preferences.current,
            )
          },
        ),
        consult: consultVia({ host, options, preferences }),
      })
    }),
  )
}

export default Advisor
