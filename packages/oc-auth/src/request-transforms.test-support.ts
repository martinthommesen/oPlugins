import { Brand, Effect, Layer, Option, Queue, Stream } from "effect"
import type { Cause, Config } from "effect"
import type {
  SessionContext,
  SessionHttpRequest,
} from "@opencode/plugin/effect/session"
import { NodeCrypto } from "@effect/platform-node-shared"
import type { Plugin } from "@opencode/plugin/effect"
import PluginOptions from "./plugin-options.ts"
import type PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import RequestTransforms from "./request-transforms.ts"
import testEnvironment from "./test-environment.test-support.ts"

/** A response whose body a test writes while the response is being read. */
interface OpenStream {
  /** End the body. */
  readonly close: Effect.Effect<boolean>
  /** Write `text` to the body. */
  readonly push: (text: string) => Effect.Effect<boolean>
  /** The response carrying the body. */
  readonly response: Response
}

const EVENT_STREAM = { "content-type": "text/event-stream" },
  HOME = "/nonexistent-claude-auth-home",
  asAgent = Brand.nominal<SessionContext["agent"]>(),
  asModel = Brand.nominal<SessionContext["model"]["id"]>(),
  asProvider = Brand.nominal<SessionContext["model"]["providerID"]>(),
  asSession = Brand.nominal<SessionContext["sessionID"]>(),
  /* The whole body of `source` as text; an absent body is empty. */
  bodyText = (source: Request | Response): Effect.Effect<string> =>
    Option.match(Option.fromNullishOr(source.body), {
      onNone: () => Effect.succeed(""),
      onSome: (body) =>
        Stream.fromReadableStream({
          evaluate: () => body,
          onError: (cause) => cause,
        }).pipe(Stream.decodeText, Stream.mkString, Effect.orDie),
    }),
  /*
   * A session context as the host hands it to the `context` hook: two system
   * parts, a user turn, a `read` call and its result, and two tools.
   */
  contextEvent = (): SessionContext => {
    const edit = { description: "Edit files", input: { type: "object" } },
      read = { description: "Read files", input: { type: "object" } }

    return {
      agent: asAgent("build"),
      messages: [
        { content: [{ text: "Update the file", type: "text" }], role: "user" },
        {
          content: [{ id: "one", input: {}, name: "read", type: "tool-call" }],
          role: "assistant",
        },
        {
          content: [
            {
              id: "one",
              name: "read",
              result: { type: "text", value: "contents" },
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
      model: {
        id: asModel("claude-sonnet-4-5"),
        providerID: asProvider("anthropic"),
      },
      options: {},
      sessionID: asSession("session"),
      system: [
        { text: "Use read before edit.", type: "text" },
        { text: "Keep changes focused.", type: "text" },
      ],
      tools: { edit, read },
    }
  },
  /* A response whose body `upstream` feeds, with `headers`. */
  feedResponse = (
    upstream: Queue.Queue<string, Cause.Done>,
    headers: Readonly<Record<string, string>>,
  ): Effect.Effect<Response> =>
    Stream.fromQueue(upstream).pipe(
      Stream.encodeText,
      Stream.toReadableStreamEffect(),
      Effect.map((body) => new Response(body, { headers })),
    ),
  /* An `http.request` event carrying `request` for `model`. */
  httpEvent = (request: Request, model: string): SessionHttpRequest => ({
    agent: asAgent("build"),
    kind: "primary",
    model: { id: asModel(model), providerID: asProvider("anthropic") },
    request,
    sessionID: asSession("session"),
  }),
  /* An event-stream response whose body the test writes and ends. */
  openStream = Effect.gen(function* openStream() {
    const chunks = yield* Queue.unbounded<string, Cause.Done>(),
      response = yield* feedResponse(chunks, EVENT_STREAM)

    return {
      close: Queue.end(chunks),
      push: (text: string): Effect.Effect<boolean> => Queue.offer(chunks, text),
      response,
    } satisfies OpenStream
  }),
  /* A finished response whose body arrives as `chunks`. */
  streamed = (
    chunks: readonly string[],
    headers: Readonly<Record<string, string>> = EVENT_STREAM,
  ): Effect.Effect<Response> =>
    Stream.fromIterable(chunks).pipe(
      Stream.encodeText,
      Stream.toReadableStreamEffect(),
      Effect.map((body) => new Response(body, { headers })),
    ),
  /*
   * The live transforms with the plugin's `options`, on a machine whose
   * home does not exist.
   */
  transformsLayer = (
    options: Plugin.Context["options"] = {},
  ): Layer.Layer<
    RequestTransforms,
    Config.ConfigError | PluginOptionsError
  > => {
    const environment = testEnvironment({ HOME })(),
      settings = PluginOptions.layer(options)

    return RequestTransforms.layer.pipe(
      Layer.provide(Layer.mergeAll(NodeCrypto.layer, environment, settings)),
    )
  }

/** What the request and response transform tests share. */
export default Object.freeze({
  bodyText,
  contextEvent,
  httpEvent,
  layer: transformsLayer,
  openStream,
  streamed,
})
