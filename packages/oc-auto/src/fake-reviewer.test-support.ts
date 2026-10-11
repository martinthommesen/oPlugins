import { Array as Arr, Context, Effect, Layer, Ref } from "effect"
import Reviewer from "./reviewer.ts"

type Review = Reviewer["Service"]["review"]

type ReviewRequest = Parameters<Review>[typeof FIRST]

const FIRST = 0

/** The requests a scripted reviewer received, oldest first. */
class FakeReviewer extends Context.Service<
  FakeReviewer,
  { readonly requests: Effect.Effect<readonly ReviewRequest[]> }
>()("@martinthommesen/oc-auto/fake-reviewer.test-support/FakeReviewer") {
  /* A reviewer that records each request and answers with `script`. */
  public static readonly layer = (
    script: () => ReturnType<Review>,
  ): Layer.Layer<FakeReviewer | Reviewer> =>
    Layer.effectContext(
      Effect.gen(function* fakeReviewer() {
        const requests = yield* Ref.make<readonly ReviewRequest[]>([]),
          scripted = Reviewer.of({
            review: (request) =>
              Ref.update(requests, Arr.append(request)).pipe(
                Effect.flatMap(script),
              ),
          })

        return Context.make(FakeReviewer, {
          requests: Ref.get(requests),
        }).pipe(Context.add(Reviewer, scripted))
      }),
    )
}

export default FakeReviewer
