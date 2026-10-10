import { Context, Duration, Effect, Layer, Option } from "effect"
import ConsultationTimedOut from "./consultation-timed-out-error.ts"
import Host from "./host.ts"
import type HostError from "./host-error.ts"
import PreferenceStore from "./preference-store.ts"
import type { Session } from "@opencode/schema/session"
import Settings from "./settings.ts"
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
  readonly availability: (
    sessionId: Session.ID,
  ) => Effect.Effect<Availability, HostError>
  /** Asks the advisor model about a session's conversation. */
  readonly consult: (
    sessionId: Session.ID,
    question: Option.Option<string>,
  ) => Effect.Effect<Advice, ConsultationError>
}

/** The services a consultation draws on. */
interface Consultants {
  readonly host: Host["Service"]
  readonly preferences: PreferenceStore["Service"]
  readonly settings: Settings["Service"]
}

/* Whether `sessionId` may consult the advisor under `choices`. */
const availabilityIn = (
    host: Host["Service"],
    sessionId: Session.ID,
    choices: Preferences,
  ): Effect.Effect<Availability, HostError> =>
    availability.decideAvailability(
      choices,
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
  /* Builds `consult` on the services it draws on. */
  consultVia = ({
    host,
    preferences,
    settings,
  }: Consultants): Interface["consult"] =>
    Effect.fn("Advisor.consult")(function* consult(
      sessionId: Session.ID,
      question: Option.Option<string>,
    ) {
      const choices = yield* preferences.current,
        request = Effect.gen(function* requestAdvice() {
          const advisorModel = yield* availabilityIn(
              host,
              sessionId,
              choices,
            ).pipe(Effect.flatMap(availability.requireModel)),
            ref = yield* modelRef.parseModelRef(advisorModel),
            transcript = yield* host.transcript(sessionId)

          return {
            model: advisorModel,
            text: yield* host.consult(
              sessionId,
              prompt.advisorPrompt(
                transcript,
                settings.maxTranscriptChars,
                question,
              ),
              ref,
            ),
          }
        })

      return yield* request.pipe(
        byDeadline(
          settings.timeout,
          Option.getOrElse(choices.model, () => "not configured"),
        ),
      )
    })

/** Consults the configured advisor model about a session's conversation. */
class Advisor extends Context.Service<Advisor, Interface>()(
  "@martinthommesen/oc-advisor/advisor",
) {
  /** The advisor, on the host, preferences, and settings in context. */
  public static readonly layer = Layer.effect(
    Advisor,
    Effect.gen(function* makeAdvisor() {
      const host = yield* Host,
        preferences = yield* PreferenceStore,
        settings = yield* Settings

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
        consult: consultVia({ host, preferences, settings }),
      })
    }),
  )
}

export default Advisor
