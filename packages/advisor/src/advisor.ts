import { Context, Duration, Effect, Layer, Option } from "effect"
import { decideAvailability, requireModel } from "./availability.ts"
import type { Availability } from "./availability.ts"
import type { ConsultationError } from "./errors/consultation-error.ts"
import { ConsultationTimedOut } from "./errors/consultation-timed-out.ts"
import { Host } from "./host.ts"
import type { HostError } from "./errors/host-error.ts"
import { PreferenceStore } from "./preferences.ts"
import type { Preferences } from "./preferences.ts"
import type { SessionId } from "./host.ts"
import { Settings } from "./settings.ts"
import { advisorPrompt } from "./prompt.ts"
import { parseModelRef } from "./model-ref.ts"

interface Advice {
  readonly model: string
  readonly text: string
}

interface Interface {
  readonly availability: (
    sessionId: SessionId,
  ) => Effect.Effect<Availability, HostError>
  /** Asks the advisor model about a session's conversation. */
  readonly consult: (
    sessionId: SessionId,
    question: Option.Option<string>,
  ) => Effect.Effect<Advice, ConsultationError>
}

/**
 * Fails a consultation that outlasts its deadline.
 * @param {Duration.Duration} timeout The deadline.
 * @param {string} model The advisor model, for the error.
 * @returns {Function} A pipeline step that applies the deadline.
 */
const withDeadline =
  (timeout: Duration.Duration, model: string) =>
  <Value, Failure>(
    self: Effect.Effect<Value, Failure>,
  ): Effect.Effect<Value, Failure | ConsultationTimedOut> =>
    Effect.timeoutOrElse(self, {
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new ConsultationTimedOut({
            model,
            seconds: Duration.toSeconds(timeout),
          }),
        ),
    })

const inSession = (
  host: Host["Service"],
  sessionId: SessionId,
  choices: Preferences,
): Effect.Effect<Availability, HostError> =>
  decideAvailability(
    choices,
    host.parent(sessionId).pipe(Effect.map(Option.isSome)),
  )

class Advisor extends Context.Service<Advisor, Interface>()(
  "opencode-advisor/Advisor",
) {
  public static readonly layer = Layer.effect(
    Advisor,
    Effect.gen(function* makeAdvisor() {
      const host = yield* Host
      const preferences = yield* PreferenceStore
      const settings = yield* Settings

      const availability = Effect.fn("Advisor.availability")(
        function* availability(sessionId: SessionId) {
          return yield* inSession(host, sessionId, yield* preferences.current)
        },
      )

      const consult = Effect.fn("Advisor.consult")(function* consult(
        sessionId: SessionId,
        question: Option.Option<string>,
      ) {
        const choices = yield* preferences.current

        const request = Effect.gen(function* requestAdvice() {
          const model = yield* inSession(host, sessionId, choices).pipe(
            Effect.flatMap(requireModel),
          )

          const ref = yield* parseModelRef(model)

          const items = yield* host.transcript(sessionId)

          const prompt = advisorPrompt(
            items,
            settings.maxTranscriptChars,
            question,
          )

          const text = yield* host.consult(sessionId, prompt, ref)

          return { model, text }
        })

        return yield* request.pipe(
          withDeadline(
            settings.timeout,
            Option.getOrElse(choices.model, () => "not configured"),
          ),
        )
      })

      return Advisor.of({ availability, consult })
    }),
  )
}

export { Advisor }

export type { Advice }
