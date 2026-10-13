import { Effect } from "effect"
import type { Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/effect/storage"

/** Stored keys and their values. */
type Entries = readonly (readonly [string, Schema.Json])[]

/* The plugin's durable storage, in memory, starting with `initial`. */
const memoryStorage = (initial: Entries = []): StorageDomain => {
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
  /* A connection API with no connection at all. */
  unconnected = {
    integration: {
      connection: {
        active: (): Effect.Effect<undefined> => Effect.undefined,
        resolve: (): Effect.Effect<undefined> => Effect.undefined,
      },
    },
  }

/** Fakes of the host's plugin context. */
export default Object.freeze({ memoryStorage, unconnected })
