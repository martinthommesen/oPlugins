import { Effect, Option } from "effect"
import ClaudeCodeStoreError from "./claude-code-store-error.ts"
import type ClaudeCredentials from "./claude-credentials.ts"
import DebugLog from "./debug-log.ts"
import credentialBlob from "./claude-credentials-blob.ts"
import keychainItems from "./keychain-items.ts"
import sources from "./claude-code-sources.ts"
import storeSelect from "./claude-code-store-select.ts"

type CredentialStore = Option.Option.Value<
  Effect.Success<ReturnType<typeof storeSelect.storeFor>>
>

type Credentials = typeof ClaudeCredentials.Type

type LogEntries = CredentialStore["fields"]

/**
 * `failed` is a decision about the stored blob or the item, which another
 * attempt would repeat. `unavailable` means the store could not be reached,
 * even after a second attempt.
 */
type WriteBackResult = "conflict" | "failed" | "unavailable" | "written"

/** Refreshed tokens to write back into the store they came from. */
interface WriteBackRequest {
  readonly configDir: Option.Option<string>
  readonly credentials: Pick<
    Credentials,
    "accessToken" | "expiresAt" | "refreshToken"
  >
  /** The access token the store held when the refresh started. */
  readonly expectedAccessToken: string
  readonly source: string
}

/** A blob read just before the write, and the write prepared for it. */
interface StagedWrite {
  readonly blob: string
  readonly write: Effect.Success<CredentialStore["prepareWrite"]>
}

const UNAVAILABLE = "unavailable",
  /* Log fields from a store's context plus `extra`. */
  fieldsOf = (
    fields: LogEntries,
    extra: readonly (readonly [string, string])[],
  ): Readonly<Record<string, string>> =>
    Object.fromEntries([...fields, ...extra]),
  /*
   * Why a stored blob must not be overwritten. Two opposite causes share
   * this refusal. Either another account legitimately holds the slot, which
   * needs no action, or the blob cannot be read at all, which means
   * corruption and needs a human. Both refuse but log different events.
   */
  refuseWrite = Effect.fn("ClaudeCodeWriteBack.refuseWrite")(
    function* refuseWrite(
      stored: Option.Option<Credentials>,
      fields: LogEntries,
    ) {
      const debug = yield* DebugLog

      if (Option.isNone(stored)) {
        yield* debug.log("writeback_skipped_unparseable", fieldsOf(fields, []))

        return "failed" satisfies WriteBackResult
      }

      yield* debug.log(
        "writeback_skipped_stale",
        fieldsOf(fields, [
          ["stored", yield* sources.tokenFingerprint(stored.value.accessToken)],
        ]),
      )

      return "conflict" satisfies WriteBackResult
    },
  ),
  /*
   * Why the stored blob must not be refreshed in place, or none when it
   * still carries the access token we expect.
   *
   * Guards write-back against an external switch landing between the read
   * that produced the token being refreshed and the read just before the
   * write. An unparseable blob is refused, because a write into state we
   * cannot identify is what this guard exists to prevent.
   *
   * This guard is stricter than the write it guards. It validates through
   * parseCredentials (field types, mcpOAuth-only rejection), while
   * updateCredentialBlob rewrites any JSON object. So a blob the write path
   * would happily update can still be refused here. That gap is
   * intentional. Reaching this guard means an earlier parseCredentials
   * succeeded, so a blob that no longer parses changed shape after we read
   * it (a truncated non-atomic external write, or a hand edit), and
   * declining to write over it is correct. Anyone tightening
   * parseCredentials should know it narrows write-back too, not just reads.
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
    const debug = yield* DebugLog,
      readBack = yield* store.read

    if (!Option.contains(readBack, written)) {
      return yield* new ClaudeCodeStoreError({
        message: "the written credentials did not read back",
      })
    }

    return yield* debug.log("writeback_success", fieldsOf(store.fields, []))
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
    (effect, store) =>
      Effect.gen(function* reported() {
        const debug = yield* DebugLog,
          report = (
            event: string,
            message: string,
            result: WriteBackResult,
          ): Effect.Effect<WriteBackResult> =>
            debug
              .log(event, fieldsOf(store.fields, [["error", message]]))
              .pipe(Effect.as(result))

        return yield* effect.pipe(
          Effect.catchTags({
            ClaudeCodeStoreError: (failure: { readonly message: string }) =>
              report("writeback_failed", failure.message, UNAVAILABLE),
            ClaudeCodeWriteRefusedError: (failure: {
              readonly message: string
            }) => report("writeback_refused", failure.message, "failed"),
          }),
        )
      }),
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
      Effect.flatMap((first) => {
        if (first !== UNAVAILABLE) {
          return Effect.succeed(first)
        }

        return writeThrough(store, request)
      }),
    ),
  /*
   * Guarded write of refreshed tokens into the source they came from. The
   * blob is read just before the write and the write is declined when it
   * changed, which preserves unrelated concurrent edits and source
   * rotations that land before that read.
   *
   * This is not atomic. The read and the write are separate operations, and
   * the Claude CLI does not take this plugin's refresh lock, so a rotation
   * it makes in between is overwritten. The refresh lock serializes the
   * plugin's own refreshes, but it is best-effort and can degrade, so they
   * can race here too, though rarely.
   *
   * An unreachable store gets a second attempt. It reuses the guard token:
   * re-reading it would compare the source against itself and turn the
   * retry into an unguarded write over a credential rotated in the gap. A
   * real rotation returns "conflict" instead.
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
export default Object.freeze({ writeBack: writeTwice })
