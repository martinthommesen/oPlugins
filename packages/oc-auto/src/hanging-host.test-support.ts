import { Context, Effect, Layer, Ref } from "effect"
import Host from "./host.ts"

/** Whether a host that never answers was interrupted while asked. */
class HangingHost extends Context.Service<
  HangingHost,
  { readonly interrupted: Ref.Ref<boolean> }
>()("@martinthommesen/oc-auto/hanging-host.test-support/HangingHost") {
  /** A host whose session lookups never finish and record being interrupted. */
  public static readonly layer: Layer.Layer<HangingHost | Host> =
    Layer.effectContext(
      Effect.gen(function* hangingHost() {
        const interrupted = yield* Ref.make(false),
          stalledHost = Host.of({
            openAiCredential: Effect.succeedNone,
            session: () =>
              Effect.never.pipe(
                Effect.onInterrupt(() => Ref.set(interrupted, true)),
              ),
          })

        return Context.make(HangingHost, { interrupted }).pipe(
          Context.add(Host, stalledHost),
        )
      }),
    )
}

export default HangingHost
