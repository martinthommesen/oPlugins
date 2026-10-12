import { Effect, Option } from "effect"
import ClaudeCodeStoreError from "./claude-code-store-error.ts"
import type ClaudeCredentials from "./claude-credentials.ts"
import credentialBlob from "./claude-credentials-blob.ts"
import keychainItems from "./keychain-items.ts"
import pluginLog from "./plugin-log.ts"
import sources from "./claude-code-sources.ts"
import storeSelect from "./claude-code-store-select.ts"

type CredentialStore = Option.Option.Value<
  Effect.Success<ReturnType<typeof storeSelect.storeFor>>
>

type Credentials = typeof ClaudeCredentials.Type

type LogEntries = CredentialStore["fields"]

/**
 * How a write-back ended. `written`: the tokens landed and read back.
 * `conflict`: the store holds another access token, from a rotation or a
 * newer login. `failed`: the plugin declined to write, for a reason another
 * attempt would repeat. `unavailable`: the store could not be reached, even
 * on a second attempt.
 */
type WriteBackResult = "conflict" | "failed" | "unavailable" | "written"

/** Refreshed tokens to write back into the store they came from. */
interface WriteBackRequest {
  /** The account's config directory, which locates a credentials file. */
  readonly configDir: Option.Option<string>
  /** The refreshed tokens. */
  readonly credentials: Pick<
    Credentials,
    "accessToken" | "expiresAt" | "refreshToken"
  >
  /** The access token the store held when the refresh started. */
  readonly expectedAccessToken: string
  /** The `source` that names the store. */
  readonly source: string
}

/** A blob read just before the write, and the write prepared for it. */
interface StagedWrite {
  /** The stored blob, read just before the write. */
  readonly blob: string
  /** The write, prepared ahead of that read. */
  readonly write: Effect.Success<CredentialStore["prepareWrite"]>
}

const UNAVAILABLE = "unavailable",
  /* A store's log annotations plus `extra`. */
  fieldsOf = (
    fields: LogEntries,
    extra: readonly (readonly [string, string])[],
  ): Readonly<Record<string, string>> =>
    Object.fromEntries([...fields, ...extra]),
  /*
   * The result of refusing to overwrite `stored`, which has one of two
   * opposite causes. A blob with another access token, from a rotation or a
   * newer login, is a conflict that needs no action. A blob that no longer
   * parses is corrupt and needs the user, so the write fails. Each cause
   * logs its own event.
   */
  refuseWrite = Effect.fn("ClaudeCodeWriteBack.refuseWrite")(
    function* refuseWrite(
      stored: Option.Option<Credentials>,
      fields: LogEntries,
    ) {
      if (Option.isNone(stored)) {
        yield* pluginLog.debug(
          "writeback_skipped_unparseable",
          fieldsOf(fields, []),
        )

        return "failed" satisfies WriteBackResult
      }

      yield* pluginLog.debug(
        "writeback_skipped_stale",
        fieldsOf(fields, [
          ["stored", yield* sources.tokenFingerprint(stored.value.accessToken)],
        ]),
      )

      return "conflict" satisfies WriteBackResult
    },
  ),
  /*
   * The result to return instead of writing, or none when the stored blob
   * still carries the expected access token. The guard catches a login or
   * rotation that landed between the read that produced the token being
   * refreshed and the read just before the write. A blob that does not
   * parse is refused too, since the plugin cannot tell whose credentials it
   * holds.
   *
   * The guard is stricter than the write. It parses with `parseCredentials`
   * (field types, no mcpOAuth-only blob), while `updateCredentialBlob`
   * rewrites any JSON object. The gap is intended: an earlier
   * `parseCredentials` of this store succeeded, so a blob that no longer
   * parses changed shape since (a truncated external write, or a hand
   * edit), and is not written over. Tightening `parseCredentials` narrows
   * write-back as well as reads.
   */
  staleVerdict = Effect.fn("ClaudeCodeWriteBack.staleBlobResult")(
    function* staleVerdict(raw: string, expected: string, fields: LogEntries) {
      const stored = yield* credentialBlob.parseCredentials(raw)

      if (Option.exists(stored, (found) => found.accessToken === expected)) {
        return Option.none<WriteBackResult>()
      }

      return Option.some<WriteBackResult>(
        yield* refuseWrite(stored, [
          ...fields,
          ["expected", yield* sources.tokenFingerprint(expected)],
        ]),
      )
    },
  ),
  /*
   * A store can accept a write and keep something else; `security` once
   * stored an empty password and exited 0. Success is what reads back.
   */
  verified = Effect.fn("ClaudeCodeWriteBack.verify")(function* verified(
    store: CredentialStore,
    written: string,
  ) {
    const readBack = yield* store.read

    if (!Option.contains(readBack, written)) {
      return yield* ClaudeCodeStoreError.make({
        message: "The written credentials did not read back.",
      })
    }

    return yield* pluginLog.debug(
      "writeback_success",
      fieldsOf(store.fields, []),
    )
  }),
  /* Write the refreshed tokens over `staged.blob`, unless the guard refuses. */
  writeStaged = Effect.fn("ClaudeCodeWriteBack.writeStaged")(
    function* writeStaged(
      store: CredentialStore,
      request: WriteBackRequest,
      staged: StagedWrite,
    ) {
      const stale = yield* staleVerdict(
          staged.blob,
          request.expectedAccessToken,
          store.fields,
        ),
        updated = credentialBlob.updateCredentialBlob(
          staged.blob,
          request.credentials,
        )

      if (Option.isSome(stale)) {
        return stale.value
      }

      if (Option.isNone(updated)) {
        return "failed" satisfies WriteBackResult
      }

      yield* staged.write(updated.value)
      yield* verified(store, updated.value)

      return "written" satisfies WriteBackResult
    },
  ),
  /*
   * One guarded write. Anything slow, such as the Keychain account lookup,
   * runs before the guard read to keep the window before the write short.
   */
  writeThrough = Effect.fn("ClaudeCodeWriteBack.attempt")(
    function* writeThrough(store: CredentialStore, request: WriteBackRequest) {
      const prepared = yield* store.prepareWrite,
        raw = yield* store.read

      if (Option.isNone(raw)) {
        return "failed" satisfies WriteBackResult
      }

      return yield* writeStaged(store, request, {
        blob: raw.value,
        write: prepared,
      })
    },
    (effect, store) => {
      const report = (
        event: string,
        message: string,
        result: WriteBackResult,
      ): Effect.Effect<WriteBackResult> =>
        pluginLog
          .debug(event, fieldsOf(store.fields, [["error", message]]))
          .pipe(Effect.as(result))

      return effect.pipe(
        Effect.catchTags({
          ClaudeCodeStoreError: (failure: { readonly message: string }) =>
            report("writeback_failed", failure.message, UNAVAILABLE),
          ClaudeCodeWriteRefusedError: (failure: {
            readonly message: string
          }) => report("writeback_refused", failure.message, "failed"),
        }),
      )
    },
  ),
  /* One guarded write, and a second one when the store was unreachable. */
  writeThroughTwice = (
    store: CredentialStore,
    request: WriteBackRequest,
  ): Effect.Effect<
    WriteBackResult,
    never,
    Effect.Services<ReturnType<typeof writeThrough>>
  > =>
    writeThrough(store, request).pipe(
      Effect.filterOrElse(
        (first) => first !== UNAVAILABLE,
        () => writeThrough(store, request),
      ),
    ),
  /*
   * Write refreshed tokens back into the store they came from, guarded. The
   * blob is read just before the write, which keeps any other edit made
   * before that read, and the write is declined when the blob holds another
   * access token, which keeps a rotation made before that read.
   *
   * This is not atomic. The read and the write are separate operations, and
   * Claude Code does not take this plugin's refresh lock, so a rotation it
   * makes in between is overwritten. The refresh lock serializes the
   * plugin's own refreshes, but it is best effort and can degrade, so they
   * can race here too, though rarely.
   *
   * An unreachable store gets a second attempt with the same expected
   * token. Taking the token from a fresh read instead would compare the
   * store with itself, and turn the retry into an unguarded write over a
   * rotation made in the gap. A real rotation returns "conflict" instead.
   */
  writeTwice = Effect.fn("ClaudeCodeWriteBack.writeBack")(function* writeTwice(
    request: WriteBackRequest,
  ) {
    const found = yield* storeSelect.storeFor(
      request.source,
      request.configDir,
      keychainItems.WRITE_PATH_TIMEOUT,
    )

    if (Option.isNone(found)) {
      return "failed" satisfies WriteBackResult
    }

    return yield* writeThroughTwice(found.value, request)
  })

/** Writing refreshed tokens back into the Claude Code store they came from. */
/** @internal */
export default Object.freeze({ writeBack: writeTwice })
