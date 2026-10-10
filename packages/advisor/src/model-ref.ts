import { Array as Arr, Effect, Option, Struct, pipe } from "effect"
import { InvalidModel } from "./errors/invalid-model.ts"
import { Model } from "@opencode/plugin/effect"

/**
 * Parses a `provider/model[#variant]` reference.
 * @param {string} model The reference as the user wrote it.
 * @returns {Effect.Effect<Model.Ref, InvalidModel>} The parsed reference.
 */
const parseModelRef = (model: string): Effect.Effect<Model.Ref, InvalidModel> =>
  Effect.try({
    catch: () =>
      new InvalidModel({
        model,
        reason: "expected provider/model or provider/model#variant",
      }),
    try: () => Model.Ref.parse(model),
  })

/**
 * Tests whether a model offers the variant a reference asks for.
 * @param {Model.Ref} ref The parsed reference.
 * @returns {(info: Model.Info) => boolean} The test.
 */
const offersVariant =
  (ref: Model.Ref) =>
  (info: Model.Info): boolean =>
    Option.match(Option.fromUndefinedOr(ref.variant), {
      onNone: () => true,
      onSome: (id) =>
        pipe(info.variants, Arr.map(Struct.get("id")), Arr.contains(id)),
    })

/**
 * Checks that a reference names a model the user can select.
 * @param {Model.Ref} ref The parsed reference.
 * @param {string} model The reference as the user wrote it.
 * @param {readonly Model.Info[]} available The selectable models.
 * @returns {Effect.Effect<Model.Info, InvalidModel>} The matching model.
 */
const findModel = (
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
    Option.match({
      onNone: () =>
        Effect.fail(
          new InvalidModel({ model, reason: "no available model has that id" }),
        ),
      onSome: Effect.succeed,
    }),
    Effect.filterOrFail(
      offersVariant(ref),
      () =>
        new InvalidModel({ model, reason: "the model has no such variant" }),
    ),
  )

export { findModel, parseModelRef }
