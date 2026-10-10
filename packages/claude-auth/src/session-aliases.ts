import { Context, Effect, Layer, Option, Ref } from "effect"
import toolAliases from "./tool-aliases.ts"

type OriginalByAlias = ReturnType<typeof toolAliases.invert>

/** Remembered aliases, oldest-touched first. */
type Remembered = readonly (readonly [string, OriginalByAlias])[]

/*
 * Session and request-kind pairs whose wire aliases are retained. Only a
 * fallback for when the per-request state is unavailable, so evicting the
 * coldest entry costs at most one response's tool-name restoration in a
 * session that went quiet.
 */
const MAX_TRACKED_CONTEXTS = 512,
  /* `remembered` without `key`. */
  dropped = (remembered: Remembered, key: string): Remembered =>
    remembered.filter(([candidate]) => candidate !== key),
  /* The aliases `remembered` keeps under `key`, if any. */
  found = (
    remembered: Remembered,
    key: string,
  ): Option.Option<OriginalByAlias> =>
    Option.fromUndefinedOr(
      remembered.find(([candidate]) => candidate === key),
    ).pipe(Option.map(([, aliases]) => aliases)),
  /* The aliases `remembered` keeps under `key`, or none at all. */
  keptUnder = (remembered: Remembered, key: string): OriginalByAlias =>
    Option.getOrElse(found(remembered, key), () => ({})),
  /*
   * `remembered` with `aliases` under `key`, moved to the end so eviction
   * takes the context idle longest rather than the one that started first.
   */
  withAliases = (
    remembered: Remembered,
    key: string,
    aliases: OriginalByAlias,
  ): Remembered =>
    [...dropped(remembered, key), [key, aliases] as const].slice(
      -MAX_TRACKED_CONTEXTS,
    )

/**
 * The wire aliases in use, per session and request kind. The context hook
 * resets an entry each turn with the registered tools, and the request hook
 * adds what the body it rewrote carried. Keyed by session rather than by
 * request, because the host may hand the response hook a different
 * `Request`, and a hook that re-runs on its own output finds nothing new to
 * alias. Bounded, because the plugin lives in a server that outlives any
 * individual session and the host has no session-ended signal.
 */
class SessionAliases extends Context.Service<
  SessionAliases,
  {
    /** Forget the aliases kept under `key`. */
    readonly forget: (key: string) => Effect.Effect<void>
    /** The aliases kept under `key`, if any. */
    readonly get: (key: string) => Effect.Effect<Option.Option<OriginalByAlias>>
    /** Add `aliases` to those kept under `key`; the newer mapping wins. */
    readonly merge: (
      key: string,
      aliases: OriginalByAlias,
    ) => Effect.Effect<void>
    /** Keep exactly `aliases` under `key`. */
    readonly replace: (
      key: string,
      aliases: OriginalByAlias,
    ) => Effect.Effect<void>
  }
>()("oclaude/session-aliases/SessionAliases") {
  /* The key for one session and request kind. */
  public static readonly keyOf = (sessionID: string, kind: string): string =>
    `${sessionID}:${kind}`

  /** Aliases kept for the plugin's lifetime. */
  public static readonly layer: Layer.Layer<SessionAliases> = Layer.effect(
    SessionAliases,
    Effect.gen(function* makeSessionAliases() {
      const remembered = yield* Ref.make<Remembered>([])

      return SessionAliases.of({
        forget: (key) =>
          Ref.update(remembered, (entries) => dropped(entries, key)),
        get: (key) =>
          Ref.get(remembered).pipe(
            Effect.map((entries) => found(entries, key)),
          ),
        merge: (key, aliases) =>
          Ref.update(remembered, (entries) =>
            withAliases(
              entries,
              key,
              toolAliases.merge(keptUnder(entries, key), aliases),
            ),
          ),
        replace: (key, aliases) =>
          Ref.update(remembered, (entries) =>
            withAliases(entries, key, aliases),
          ),
      })
    }),
  )
}

export default SessionAliases
