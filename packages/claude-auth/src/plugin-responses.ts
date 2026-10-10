const MAX_RETRY_SECONDS = 60,
  MIN_RETRY_SECONDS = 1,
  MS_PER_SECOND = 1000,
  TOO_MANY_REQUESTS = 429,
  UNAUTHORIZED = 401,
  /* An error body in the API's own format, with its keys in the API's order. */
  apiError = (type: string, message: string): string =>
    JSON.stringify(
      Object.fromEntries([
        ["type", "error"],
        [
          "error",
          Object.fromEntries([
            ["type", type],
            ["message", message],
          ]),
        ],
      ]),
    ),
  /*
   * A 401 in the API's own error format, so the SDK reports `message` the way
   * it reports any provider error. Used when recovery from a 401 ended in a
   * credential error the user has to act on.
   */
  authenticationError = (message: string): Response =>
    new Response(apiError("authentication_error", message), {
      headers: { "content-type": "application/json" },
      status: UNAUTHORIZED,
    }),
  /*
   * The plugin's own 429 while token refresh is unavailable. `retry-after` is
   * whole seconds, rounded up so a client never retries early, and capped at
   * the longest cooldown.
   */
  retryableRefresh = (retryAfterMs: number): Response => {
    const seconds = Math.min(
      MAX_RETRY_SECONDS,
      Math.max(MIN_RETRY_SECONDS, Math.ceil(retryAfterMs / MS_PER_SECOND)),
    )

    return new Response(
      apiError(
        "rate_limit_error",
        "Claude token refresh is temporarily unavailable.",
      ),
      {
        headers: {
          "content-type": "application/json",
          "retry-after": String(seconds),
          "x-should-retry": "true",
        },
        status: TOO_MANY_REQUESTS,
      },
    )
  }

/** The responses the plugin answers with itself instead of the API's. */
export default Object.freeze({ authenticationError, retryableRefresh })
