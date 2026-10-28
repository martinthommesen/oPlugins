import { Cause, Effect, Exit } from "effect"

/* Cancellation is normal during unload; other failures remain observable to the command host. */
const finish = (exit: Exit.Exit<unknown>): Effect.Effect<void> =>
  Exit.match(exit, {
    onFailure: (cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void
      }

      return Effect.failCause(cause)
    },
    onSuccess: () => Effect.void,
  })

export default Object.freeze({ finish })
