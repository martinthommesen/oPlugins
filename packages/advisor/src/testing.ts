import {
  Array as Arr,
  Boolean as Bool,
  Effect,
  Layer,
  Option,
  Ref,
  Struct,
  pipe,
} from "effect"
import { Model, Provider } from "@opencode/plugin/effect"
import { Advisor } from "./advisor.ts"
import type { ConversationItem } from "./conversation.ts"
import { Host } from "./host.ts"
import { HostError } from "./errors/host-error.ts"
import type { PluginOptions } from "@opencode/plugin/options"
import type { Schema } from "effect"
import { Session } from "@opencode/schema/session"
import type { SessionId } from "./host.ts"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { servicesLayer } from "./services.ts"

/** What a fake host answers with. */
interface HostScript {
  readonly models: readonly Model.Info[]
  /** The consulting session's parent, when it is a subagent's. */
  readonly parent: Option.Option<SessionId>
  /** The advisor model's answer to any consultation. */
  readonly reply: Effect.Effect<string, HostError>
  readonly transcript: readonly ConversationItem[]
}

/** Script entries a test replaces; the rest come from the default script. */
interface HostOverrides {
  readonly models?: readonly Model.Info[]
  /** Replaces the parent lookup, for example with a failing one. */
  readonly parentLookup?: Effect.Effect<Option.Option<SessionId>, HostError>
  /** Whether the consulting session belongs to a subagent. */
  readonly subagent?: boolean
  readonly reply?: Effect.Effect<string, HostError>
  readonly transcript?: readonly ConversationItem[]
}

/** What a fake host was asked to do. */
interface HostRecord {
  /** Prompts sent to the advisor model. */
  readonly prompts: Ref.Ref<readonly string[]>
  /** Messages shown to the user. */
  readonly notices: Ref.Ref<readonly string[]>
}

const SESSION_ID = Session.ID.make("ses_consulting")

const PARENT_ID = Session.ID.make("ses_parent")

/** A host call failing because the OpenCode server cannot be reached. */
const SERVER_UNAVAILABLE = new HostError({
  cause: "server unavailable",
  operation: "session.get",
})

/**
 * A model the fake host offers, with the given variants.
 * @param {string} reference The model as `provider/model`.
 * @param {readonly string[]} variants The model's variant ids.
 * @returns {Model.Info} The model.
 */
const modelInfo = (
  reference: string,
  variants: readonly string[],
): Model.Info => {
  const ref = Model.Ref.parse(reference)

  const base = Model.Info.default(Provider.ID.make(ref.providerID), ref.id)

  const ids = pipe(
    variants,
    Arr.map((id) => ({ id: Model.VariantID.make(id) })),
  )

  return pipe(base, Struct.assign({ variants: ids }))
}

const defaultScript: HostScript = {
  models: [modelInfo("anthropic/claude-opus-5-5", ["high"])],
  parent: Option.none(),
  reply: Effect.succeed("Use a dedicated password hash."),
  transcript: [],
}

/**
 * A host that answers from a script and records what it was asked.
 * @param {HostOverrides} overrides Script entries to replace.
 * @returns {Effect.Effect<readonly [Layer.Layer<Host>, HostRecord]>} The host
 * layer and its record.
 */
const fakeHost = Effect.fn("fakeHost")(function* fakeHost(
  overrides: HostOverrides,
): Effect.fn.Return<readonly [Layer.Layer<Host>, HostRecord]> {
  const script: HostScript = {
    models: overrides.models ?? defaultScript.models,
    parent: Bool.match(overrides.subagent ?? false, {
      onFalse: Option.none,
      onTrue: () => Option.some(PARENT_ID),
    }),
    reply: overrides.reply ?? defaultScript.reply,
    transcript: overrides.transcript ?? defaultScript.transcript,
  }

  const prompts = yield* Ref.make<readonly string[]>([])
  const notices = yield* Ref.make<readonly string[]>([])

  const host = Host.of({
    consult: (_sessionId, prompt) =>
      Ref.update(prompts, Arr.append(prompt)).pipe(
        Effect.andThen(script.reply),
      ),
    isConsultation: () => Effect.succeed(false),
    models: Effect.succeed(script.models),
    notify: (_sessionId, text) => Ref.update(notices, Arr.append(text)),
    parent: () => overrides.parentLookup ?? Effect.succeed(script.parent),
    transcript: () => Effect.succeed(script.transcript),
  })

  return [Layer.succeed(Host, host), { notices, prompts }] as const
})

/**
 * Plugin storage kept in memory.
 * @returns {StorageDomain} The storage.
 */
const memoryStorage = (): StorageDomain => {
  const entries = new Map<string, Schema.Json>()

  return {
    get: (key) => Effect.sync(() => entries.get(key)),
    remove: (key) =>
      Effect.sync(() => {
        entries.delete(key)
      }),
    scan: () => Effect.succeed({ entries: [] }),
    set: (key, value) =>
      Effect.sync(() => {
        entries.set(key, value)
      }),
  }
}

/**
 * Builds the advisor around a scripted host.
 * @param {HostOverrides} script What the host answers with.
 * @param {PluginOptions} options The plugin options.
 * @param {StorageDomain} storage The plugin's storage, empty by default.
 * @returns {Effect.Effect<readonly [Advisor["Service"], Ref.Ref<readonly string[]>]>}
 * The advisor and the prompts it sends.
 */
const advisorWith = Effect.fn("advisorWith")(function* advisorWith(
  script: HostOverrides,
  options: PluginOptions,
  storage: StorageDomain = memoryStorage(),
): Effect.fn.Return<readonly [Advisor["Service"], Ref.Ref<readonly string[]>]> {
  const [host, record] = yield* fakeHost(script)

  const services = Layer.fresh(servicesLayer(host, options, storage))

  const advisor = yield* Effect.service(Advisor).pipe(Effect.provide(services))

  return [advisor, record.prompts] as const
})

export {
  advisorWith,
  SERVER_UNAVAILABLE,
  SESSION_ID,
  fakeHost,
  memoryStorage,
  modelInfo,
}

export type { HostOverrides, HostRecord, HostScript }
