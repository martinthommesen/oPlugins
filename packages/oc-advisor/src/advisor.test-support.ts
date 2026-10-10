import { Effect, Layer } from "effect"
import FakeHost from "./fake-host.test-support.ts"
import HostError from "./host-error.ts"
import type { PluginOptions } from "@opencode/plugin/options"
import type { Schema } from "effect"
import { Session } from "@opencode/schema/session"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import services from "./services.ts"

type HostOverrides = Parameters<typeof FakeHost.layer>[typeof FIRST]

type Services = Layer.Success<ReturnType<typeof services.layer>>

type Entries = readonly (readonly [string, Schema.Json])[]

const FIRST = 0,
  /** A host call failing because the OpenCode server cannot be reached. */
  SERVER_UNAVAILABLE = HostError.make({
    cause: "server unavailable",
    operation: "session.get",
  }),
  SESSION_ID = Session.ID.make("ses_consulting"),
  /* Plugin storage kept in memory, holding `initial` to begin with. */
  memoryStorage = (initial: Entries = []): StorageDomain => {
    const entries = new Map<string, Schema.Json>(initial)

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
  },
  /*
   * The advisor's services around a host that answers from `script`, with
   * the host's record, the plugin `options`, and storage in memory holding
   * `stored`. Each build starts with fresh storage and a fresh record.
   */
  scriptedServices = (
    script: HostOverrides,
    options: PluginOptions,
    stored: Entries = [],
  ): Layer.Layer<FakeHost | Services> => {
    const host = FakeHost.layer(script)

    return Layer.merge(
      Layer.unwrap(
        Effect.sync(() => services.layer(host, options, memoryStorage(stored))),
      ),
      host,
    )
  }

/** What the advisor tests share. */
export default Object.freeze({
  SERVER_UNAVAILABLE,
  SESSION_ID,
  memoryStorage,
  scriptedServices,
})
