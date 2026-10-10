import { Context, Effect, Layer } from "effect"
import type claudeAuth from "./claude-auth-plugin.ts"

type Host = Parameters<typeof claudeAuth.setUp>[typeof FIRST]

type ModelTransform = Host["model"]["transform"]

type Editor = Parameters<Parameters<ModelTransform>[typeof FIRST]>[typeof FIRST]

/** A model the fake catalog offers. */
interface Model {
  cost: unknown[]
  readonly id: string
  readonly providerID: string
}

/** What one fake catalog keeps. */
interface CatalogState {
  readonly anthropic: Model
  readonly foreignModel: Model
  readonly shared: Editor
  readonly tally: { reloads: number }
  readonly transforms: ((editor: Editor) => void)[]
}

const FIRST = 0,
  NATIVE_COST = Object.freeze([
    Object.freeze({ cache: { read: 0.1, write: 0.2 }, input: 1, output: 2 }),
  ]),
  ONE = 1,
  /** What registering a transform hands back; disposal is the scope's job. */
  REGISTRATION = Object.freeze({ dispose: Effect.void }),
  /*
   * An Anthropic model and another provider's, natively priced, with an
   * editor over both and the transforms registered so far.
   */
  catalogState = (): CatalogState => {
    const anthropic = {
        cost: [...NATIVE_COST],
        id: "claude",
        providerID: "anthropic",
      },
      foreignModel = {
        cost: [...NATIVE_COST],
        id: "claude",
        providerID: "other",
      },
      models = [anthropic, foreignModel],
      shared: Editor = {
        list: (providerID) => {
          const found: Model[] = []

          for (const model of models) {
            if (model.providerID === providerID) {
              found.push(model)
            }
          }

          return found
        },
        update: (providerID, modelID, update) => {
          for (const model of models) {
            if (model.providerID === providerID && model.id === modelID) {
              update(model)
            }
          }
        },
      },
      tally = { reloads: FIRST },
      transforms: ((editor: Editor) => void)[] = []

    return { anthropic, foreignModel, shared, tally, transforms }
  }

/**
 * The host's model catalog. A reload restores the native prices and runs
 * every transform again, as the host does.
 */
class FakeCatalog extends Context.Service<
  FakeCatalog,
  {
    /** The model API the plugin is given. */
    readonly catalog: Host["model"]
    /** How many price entries each model carries now. */
    readonly costs: Effect.Effect<{
      readonly anthropic: number
      readonly other: number
    }>
    /** How many times the plugin reloaded the models. */
    readonly reloads: Effect.Effect<number>
  }
>()("oclaude/test/FakeCatalog") {
  /** A catalog for one test. */
  public static readonly layer: Layer.Layer<FakeCatalog> = Layer.sync(
    FakeCatalog,
    () => {
      const state = catalogState()

      return FakeCatalog.of({
        catalog: {
          reload: () =>
            Effect.sync(() => {
              state.tally.reloads += ONE
              state.anthropic.cost = [...NATIVE_COST]
              state.foreignModel.cost = [...NATIVE_COST]

              for (const transform of state.transforms) {
                transform(state.shared)
              }
            }),
          transform: (edit) =>
            Effect.sync(() => {
              state.transforms.push(edit)
              edit(state.shared)

              return REGISTRATION
            }),
        },
        costs: Effect.sync(() => ({
          anthropic: state.anthropic.cost.length,
          other: state.foreignModel.cost.length,
        })),
        reloads: Effect.sync(() => state.tally.reloads),
      })
    },
  )
}

export default FakeCatalog
