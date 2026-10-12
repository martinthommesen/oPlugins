import { Array as Arr, Effect, Option, Struct, pipe } from "effect"
import InvalidModel from "./invalid-model-error.ts"
import { Model } from "@opencode/plugin/effect"

/* Tests whether a model offers the variant a reference asks for. */
const coversVariant =
    (ref: Model.Ref) =>
    (info: Model.Info): boolean =>
      Option.match(Option.fromUndefinedOr(ref.variant), {
        onNone: () => true,
        onSome: (id) =>
          pipe(info.variants, Arr.map(Struct.get("id")), Arr.contains(id)),
      }),
  /*
   * Finds the enabled model in `available` that a parsed reference names,
   * with the variant it asks for. `model` is the reference as the user wrote
   * it, for the error.
   */
  findModel = (
    ref: Model.Ref,
    model: string,
    available: readonly Model.Info[],
  ): Effect.Effect<Model.Info, InvalidModel> =>
    pipe(
      available,
      Arr.findFirst(
        (info) =>
          info.enabled &&
          info.providerID === ref.providerID &&
          info.id === ref.id,
      ),
      Effect.fromOption(() =>
        InvalidModel.make({
          model,
          reason: "no available model has that id",
        }),
      ),
      Effect.filterOrFail(coversVariant(ref), () =>
        InvalidModel.make({ model, reason: "the model has no such variant" }),
      ),
    ),
  /* Parses a `provider/model[#variant]` reference as the user wrote it. */
  parseModelRef = (model: string): Effect.Effect<Model.Ref, InvalidModel> =>
    Effect.try({
      catch: () =>
        InvalidModel.make({
          model,
          reason: "expected provider/model or provider/model#variant",
        }),
      try: () => Model.Ref.parse(model),
    })

/** Reading and checking `provider/model[#variant]` references. */
export default Object.freeze({ findModel, parseModelRef })
