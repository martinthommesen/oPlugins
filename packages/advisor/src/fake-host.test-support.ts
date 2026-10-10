import {
  Array as Arr,
  Boolean as Bool,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Struct,
  pipe,
} from "effect"
import { Model, Provider } from "@opencode/plugin/effect"
import Host from "./host.ts"
import type HostError from "./host-error.ts"
import { Session } from "@opencode/schema/session"
import type conversation from "./conversation.ts"

type ConversationItem = ReturnType<
  typeof conversation.fromSessionMessages
>[number]

/** Script entries a test replaces; the rest come from the default script. */
interface HostOverrides {
  readonly models?: readonly Model.Info[]
  /** Replaces the parent lookup, for example with a failing one. */
  readonly parentLookup?: Effect.Effect<Option.Option<Session.ID>, HostError>
  /** Whether the consulting session belongs to a subagent. */
  readonly subagent?: boolean
  /** The advisor model's answer to any consultation. */
  readonly reply?: Effect.Effect<string, HostError>
  readonly transcript?: readonly ConversationItem[]
}

/** What a fake host was asked to do. */
interface HostRecord {
  /** Messages shown to the user. */
  readonly notices: Ref.Ref<readonly string[]>
  /** Prompts sent to the advisor model. */
  readonly prompts: Ref.Ref<readonly string[]>
}

const DEFAULT_REPLY = Effect.succeed("Use a dedicated password hash."),
  PARENT_ID = Session.ID.make("ses_parent"),
  /* A model the fake host offers as `provider/model`, with the given variant ids. */
  modelInfo = (reference: string, variants: readonly string[]): Model.Info => {
    const parsed = Model.Ref.parse(reference),
      stock = Model.Info.default(
        Provider.ID.make(parsed.providerID),
        parsed.id,
      ),
      variantIds = pipe(
        variants,
        Arr.map((id) => ({ id: Model.VariantID.make(id) })),
      )

    return pipe(stock, Struct.assign({ variants: variantIds }))
  },
  /* The models the fake host offers unless a test replaces them. */
  offeredModels = (overrides: HostOverrides): readonly Model.Info[] =>
    overrides.models ?? [modelInfo("anthropic/claude-opus-5-5", ["high"])],
  /* The consulting session's parent, when it is a subagent's. */
  parentOf = (overrides: HostOverrides): Option.Option<Session.ID> =>
    Bool.match(overrides.subagent ?? false, {
      onFalse: Option.none,
      onTrue: () => Option.some(PARENT_ID),
    }),
  /* A host that answers from `overrides` and records what it was asked in `record`. */
  scriptedHost = (
    overrides: HostOverrides,
    record: HostRecord,
  ): Host["Service"] =>
    Host.of({
      consult: (_sessionId, prompt) =>
        Ref.update(record.prompts, Arr.append(prompt)).pipe(
          Effect.andThen(overrides.reply ?? DEFAULT_REPLY),
        ),
      isConsultation: () => Effect.succeed(false),
      models: Effect.succeed(offeredModels(overrides)),
      notify: (_sessionId, text) =>
        Ref.update(record.notices, Arr.append(text)),
      parent: () =>
        overrides.parentLookup ?? Effect.succeed(parentOf(overrides)),
      transcript: () => Effect.succeed(overrides.transcript ?? []),
    })

/** What a fake host was asked to do. */
class FakeHost extends Context.Service<FakeHost, HostRecord>()(
  "opencode-advisor/fake-host.test-support/FakeHost",
) {
  /* A host that answers from a script and records what it was asked. */
  public static readonly layer = (
    overrides: HostOverrides,
  ): Layer.Layer<FakeHost | Host> =>
    Layer.effectContext(
      Effect.gen(function* fakeHost() {
        const record = FakeHost.of({
          notices: yield* Ref.make<readonly string[]>([]),
          prompts: yield* Ref.make<readonly string[]>([]),
        })

        return Context.make(FakeHost, record).pipe(
          Context.add(Host, scriptedHost(overrides, record)),
        )
      }),
    )
}

export default FakeHost
