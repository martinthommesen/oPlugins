import {
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Schema,
  Tracer,
} from "effect"
import { FetchHttpClient, Headers, HttpClient } from "effect/http"
import type { HttpClientError, HttpClientResponse } from "effect/http"
import usageFetchScope from "./usage-fetch-scope.ts"
import type usageReport from "./usage-report.ts"
import usageTimeouts from "./usage-timeouts.ts"

/** The usage a service reported. */
interface Reading {
  /** The subscription's plan, if the service named it. */
  readonly plan: Option.Option<string>
  readonly windows: readonly (typeof usageReport.LimitWindow.Type)[]
}

/** What one attempt to measure a subscription came to. */
type Outcome = Data.TaggedEnum<{
  /** The connection can't report subscription usage, such as an API key. */
  Ineligible: { readonly reason: string }
  /** The service is limiting requests, and asks for a wait. */
  Limited: { readonly problem: string; readonly wait: Duration.Duration }
  /** The service reported the usage. */
  Read: { readonly reading: Reading }
  /** The service refused the sign-in, so no earlier measurement still holds. */
  Rejected: { readonly problem: string }
  /** The usage couldn't be read this time; an earlier measurement may still hold. */
  Unreachable: { readonly problem: string }
}>

/** One usage request: where it goes, and how to read the answer. */
interface UsageRequest {
  readonly headers: Readonly<Record<string, string>>
  /** Reads the service's answer, or none when it isn't the shape expected. */
  readonly read: (body: string) => Option.Option<Reading>
  /** What to tell the user after the service refuses the sign-in. */
  readonly reconnect: string
  /** The service's name, such as `Anthropic`. */
  readonly service: string
  readonly url: string
}

interface Interface {
  /** Asks the service for the usage once. A failure is an outcome too. */
  readonly measure: (request: UsageRequest) => Effect.Effect<Outcome>
}

const DEFAULT_RATE_LIMIT_MINUTES = 10,
  HTTP_FORBIDDEN = 403,
  HTTP_SUCCESS_END = 300,
  HTTP_SUCCESS_START = 200,
  HTTP_TOO_MANY_REQUESTS = 429,
  HTTP_UNAUTHORIZED = 401,
  JsonMediaType = Schema.String.check(
    Schema.isPattern(
      /^\s*(?:application\/json|[^/;\s]+\/[^;\s]+\+json)\s*(?:;.*)?$/iu,
    ),
  ),
  MAX_MILLIS_DIVISOR = 1000,
  MAX_RETRY_SECONDS = Number.MAX_SAFE_INTEGER / MAX_MILLIS_DIVISOR,
  NO_SECONDS = 0,
  REQUEST_TIMEOUT_SECONDS = 15,
  /** A `retry-after` header in seconds; its date form falls back to the default wait. */
  RetryBounds = Schema.FiniteFromString.check(
    Schema.isGreaterThanOrEqualTo(NO_SECONDS),
    Schema.isLessThanOrEqualTo(MAX_RETRY_SECONDS),
  ),
  RetryHeader = Schema.String.check(Schema.isPattern(/^[0-9]+$/u)).pipe(
    Schema.decodeTo(RetryBounds),
  ),
  UsageOutcome = Data.taggedEnum<Outcome>(),
  /* Whether the response's body is JSON, as the services' own errors are. */
  answersJson = (response: HttpClientResponse.HttpClientResponse): boolean =>
    Headers.get(response.headers, "content-type").pipe(
      Option.exists((type) => Schema.is(JsonMediaType)(type)),
    ),
  /* The outcome of a successful response: its reading, or a problem when it can't be read. */
  bodyOutcome = (
    request: UsageRequest,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<Outcome, HttpClientError.HttpClientError> =>
    response.text.pipe(
      Effect.map((body) =>
        Option.match(request.read(body), {
          onNone: () =>
            UsageOutcome.Unreachable({
              problem: `${request.service} answered with usage that oc-usage can't read. Update oc-usage; if it persists, report the service name and plugin version.`,
            }),
          onSome: (reading) => UsageOutcome.Read({ reading }),
        }),
      ),
    ),
  decodeRetryAfter = Schema.decodeUnknownOption(RetryHeader),
  logHttpFailure = (
    failure: { readonly reason: { readonly _tag: string } },
    service: string,
  ): Effect.Effect<void> => {
    const category = Match.value(failure.reason).pipe(
      Match.tag("TransportError", () => "transport"),
      Match.orElse(() => "response"),
    )

    return Effect.logWarning("usage_http_failed").pipe(
      Effect.annotateLogs({ category, service }),
    )
  },
  observe = (service: string, outcome: Outcome): Effect.Effect<void> =>
    UsageOutcome.$match(outcome, {
      Ineligible: () => Effect.void,
      Limited: ({ wait }) =>
        Effect.logWarning("usage_request_limited").pipe(
          Effect.annotateLogs({ service, waitMillis: Duration.toMillis(wait) }),
        ),
      Read: () => Effect.void,
      Rejected: ({ problem }) =>
        Effect.logWarning("usage_request_failed").pipe(
          Effect.annotateLogs({ problem }),
        ),
      Unreachable: ({ problem }) =>
        Effect.logWarning("usage_request_failed").pipe(
          Effect.annotateLogs({ problem }),
        ),
    }),
  /* How long a rate-limited response asks oc-usage to wait. */
  retryWait = (
    response: HttpClientResponse.HttpClientResponse,
  ): Duration.Duration =>
    Headers.get(response.headers, "retry-after").pipe(
      Option.flatMap(decodeRetryAfter),
      Option.map((seconds) => Duration.seconds(seconds)),
      Option.getOrElse(() => Duration.minutes(DEFAULT_RATE_LIMIT_MINUTES)),
    ),
  /* The outcome a response's status calls for. */
  statusOutcome = (
    request: UsageRequest,
    response: HttpClientResponse.HttpClientResponse,
  ): ReturnType<typeof bodyOutcome> =>
    Match.value(response.status).pipe(
      Match.when(
        (status) => status >= HTTP_SUCCESS_START && status < HTTP_SUCCESS_END,
        () => bodyOutcome(request, response),
      ),
      // A 403 page that isn't JSON, such as a proxy's, refuses no sign-in.
      Match.when(
        (status) =>
          status === HTTP_UNAUTHORIZED ||
          (status === HTTP_FORBIDDEN && answersJson(response)),
        (status) =>
          Effect.succeed(
            UsageOutcome.Rejected({
              problem: `${request.service} refused the sign-in (HTTP ${status}). ${request.reconnect}`,
            }),
          ),
      ),
      Match.when(HTTP_TOO_MANY_REQUESTS, () =>
        Effect.succeed(
          UsageOutcome.Limited({
            problem: `${request.service} is limiting usage requests, so oc-usage waits before it asks again.`,
            wait: retryWait(response),
          }),
        ),
      ),
      Match.orElse((status) =>
        Effect.succeed(
          UsageOutcome.Unreachable({
            problem: `${request.service} answered with HTTP ${status}. Retry /usage later; if it persists, check usage_request_failed in OpenCode's server log.`,
          }),
        ),
      ),
    )

/** Asks a subscription's service for its usage. */
class UsageMeter extends Context.Service<UsageMeter, Interface>()(
  "@martinthommesen/oc-usage/usage-meter/UsageMeter",
) {
  /** What one attempt to measure a subscription came to. */
  public static readonly Outcome = UsageOutcome

  /*
   * The meter over the HTTP client. A request may take 15 seconds, and
   * never follows a redirect, so the token goes nowhere but the service.
   */
  public static readonly layer = Layer.effect(
    UsageMeter,
    Effect.gen(function* makeUsageMeter() {
      const client = yield* HttpClient.HttpClient,
        transport = yield* FetchHttpClient.Fetch

      return UsageMeter.of({
        measure: (request) =>
          client.get(request.url, { headers: request.headers }).pipe(
            Effect.provideService(FetchHttpClient.RequestInit, {
              redirect: "error",
            }),
            Effect.flatMap((response) => statusOutcome(request, response)),
            (response) => usageFetchScope.wrap(response, transport),
            Effect.provideService(Tracer.DisablePropagation, true),
            Effect.timeoutOrElse({
              duration: usageTimeouts.http,
              orElse: () =>
                Effect.succeed(
                  UsageOutcome.Unreachable({
                    problem: `${request.service} didn't answer within ${REQUEST_TIMEOUT_SECONDS} seconds. Retry /usage later; if it persists, check the service and OpenCode's server log.`,
                  }),
                ),
            }),
            Effect.tapError(
              (failure: { readonly reason: { readonly _tag: string } }) =>
                logHttpFailure(failure, request.service),
            ),
            Effect.orElseSucceed(() =>
              UsageOutcome.Unreachable({
                problem: `oc-usage couldn't reach ${request.service}. Retry /usage later; if it persists, check your network and OpenCode's server log.`,
              }),
            ),
            Effect.tap((outcome) => observe(request.service, outcome)),
            Effect.withSpan("UsageMeter.measure"),
          ),
      })
    }),
  )

  /** The meter over the Fetch API. */
  public static readonly live = UsageMeter.layer.pipe(
    Layer.provide(FetchHttpClient.layer),
  )
}

/** @internal */
export default UsageMeter
