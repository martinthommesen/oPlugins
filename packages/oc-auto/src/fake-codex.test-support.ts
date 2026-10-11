import { Array as Arr, Context, Effect, Layer, Ref } from "effect"
import CodexResponses from "./codex-client.ts"

type Complete = CodexResponses["Service"]["complete"]

/** The models a scripted Codex backend was asked for, oldest first. */
class FakeCodex extends Context.Service<
  FakeCodex,
  { readonly models: Ref.Ref<readonly string[]> }
>()("@martinthommesen/oc-auto/fake-codex.test-support/FakeCodex") {
  /* A Codex client that records each model it is asked for and answers with `script`. */
  public static readonly layer = (
    script: (model: string) => ReturnType<Complete>,
  ): Layer.Layer<CodexResponses | FakeCodex> =>
    Layer.effectContext(
      Effect.gen(function* fakeCodex() {
        const models = yield* Ref.make<readonly string[]>([]),
          recording = CodexResponses.of({
            complete: (completion) =>
              Ref.update(models, Arr.append(completion.model)).pipe(
                Effect.flatMap(() => script(completion.model)),
              ),
          })

        return Context.make(FakeCodex, { models }).pipe(
          Context.add(CodexResponses, recording),
        )
      }),
    )
}

export default FakeCodex
