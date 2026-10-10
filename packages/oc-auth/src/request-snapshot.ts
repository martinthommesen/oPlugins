import { Option } from "effect"

/**
 * Everything needed to send a request again: its target, its options, and
 * its body as already rewritten, so a 401 can be replayed with a new token.
 */
interface RequestSnapshot {
  /** The rewritten body, buffered so every replay can send it again. */
  readonly body: Option.Option<Uint8Array<ArrayBuffer>>
  readonly cache: RequestCache
  readonly credentials: RequestCredentials
  /** The headers as the host sent them, before any Claude Code header. */
  readonly headers: Headers
  readonly integrity: string
  readonly keepalive: boolean
  readonly method: string
  readonly mode: RequestMode
  /** The model the request is for, which selects its betas. */
  readonly modelID: string
  readonly redirect: RequestRedirect
  readonly referrer: string
  readonly referrerPolicy: ReferrerPolicy
  readonly signal: AbortSignal
  readonly url: string
}

const BETA_PARAMETER = "beta",
  BODILESS_METHODS = new Set(["GET", "HEAD"]),
  MESSAGES_PATH = "/v1/messages",
  /* `raw`, with `beta=true` on the Messages endpoint unless the request set it. */
  betaURL = (raw: string): string => {
    const url = new URL(raw)

    if (
      url.pathname === MESSAGES_PATH &&
      !url.searchParams.has(BETA_PARAMETER)
    ) {
      url.searchParams.set(BETA_PARAMETER, "true")
    }

    return url.toString()
  },
  /* A snapshot of `request` that sends `body` for `modelID`. */
  captureRequest = (
    request: Request,
    body: Option.Option<Uint8Array<ArrayBuffer>>,
    modelID: string,
  ): RequestSnapshot => ({
    body,
    cache: request.cache,
    credentials: request.credentials,
    headers: new Headers(request.headers),
    integrity: request.integrity,
    keepalive: request.keepalive,
    method: request.method,
    mode: request.mode,
    modelID,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
    url: betaURL(request.url),
  }),
  /* A fresh request from `snapshot`, sent with `headers`. */
  rebuildRequest = (snapshot: RequestSnapshot, headers: Headers): Request =>
    new Request(snapshot.url, {
      // The Request constructor copies the buffer, so a retry can reuse it.
      body: snapshot.body.pipe(
        Option.filter(() => !BODILESS_METHODS.has(snapshot.method)),
        Option.getOrNull,
      ),
      cache: snapshot.cache,
      credentials: snapshot.credentials,
      headers,
      integrity: snapshot.integrity,
      keepalive: snapshot.keepalive,
      method: snapshot.method,
      mode: snapshot.mode,
      redirect: snapshot.redirect,
      referrer: snapshot.referrer,
      referrerPolicy: snapshot.referrerPolicy,
      signal: snapshot.signal,
    })

/** Snapshots of outbound requests, and the requests rebuilt from them. */
export default Object.freeze({
  capture: captureRequest,
  rebuild: rebuildRequest,
})
