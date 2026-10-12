import { Array as Arr, Effect, Option, Ref, Schema, flow } from "effect"
import { FetchHttpClient } from "effect/http"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import plugin from "./index.ts"
import support from "./testing.test-support.ts"

type PluginHost = Parameters<typeof plugin.effect>[typeof FIRST]

/** A permission hook setup registered, and the hook's name. */
interface Registered {
  readonly hook: (evaluation: PermissionEvaluation) => Effect.Effect<void>
  readonly name: string
}

/** How the fake host and the fake reviewer backend answer. */
interface Script {
  /** The reviewer backend's answer to every request. */
  readonly respond: () => Response
  /** Whether OpenAI is connected with a ChatGPT sign-in. */
  readonly signedIn: boolean
}

const FIRST = 0,
  HTTP_OK = 200,
  HTTP_UNAVAILABLE = 503,
  /** The OpenAI connection the host reports when signed in. */
  OPENAI_CONNECTION = {
    id: "cred_openai",
    label: "ChatGPT",
    method: "oauth",
    type: "credential",
  } as const,
  REGISTRATION = { dispose: Effect.void },
  SESSION_ID = support.sessionId("ses_root"),
  /** The root session the permission prompt comes from. */
  SESSION_INFO = {
    cost: 0,
    id: SESSION_ID,
    location: { directory: "/auto-review-test" },
    projectID: "project_test",
    time: { created: 0, updated: 0 },
    tokens: { cache: { read: 0, write: 0 }, input: 0, output: 0, reasoning: 0 },
  },
  /** The user's request, and the agent's tool call that raised the prompt. */
  SESSION_MESSAGES = [
    {
      id: "msg_1",
      text: "Push the release.",
      time: { created: 0 },
      type: "user",
    },
    {
      agent: "build",
      content: [
        {
          id: "call_1",
          name: "bash",
          state: {
            input: { command: "git push origin main" },
            metadata: {},
            status: "running",
          },
          time: { created: 0 },
          type: "tool",
        },
      ],
      id: "msg_2",
      model: { id: "gpt-5.5", providerID: "openai" },
      time: { created: 0 },
      type: "assistant",
    },
  ],
  /* The reviewer backend answering with a stream whose text is `text`. */
  answerWith =
    (text: string): Script["respond"] =>
    () =>
      new Response(
        (
          [
            { delta: text, type: "response.output_text.delta" },
            { response: { status: "completed" }, type: "response.completed" },
          ] as const
        )
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" }, status: HTTP_OK },
      ),
  /* A permission prompt to run the tool call in the root session. */
  askToPush = (): PermissionEvaluation => ({
    action: "bash",
    effect: "ask",
    resources: ["git push origin main"],
    sessionID: SESSION_ID,
    source: { id: "call_1", messageID: "msg_2", type: "tool" },
  }),
  /* The reviewer backend assessing every planned action with `outcome`. */
  assessing = (outcome: "allow" | "deny"): Script["respond"] =>
    answerWith(
      JSON.stringify({
        outcome,
        rationale: "Pushes to the default branch.",
        risk_level: "high",
        user_authorization: "high",
      }),
    ),
  decodeMessages = Schema.decodeUnknownEffect(
    Schema.Array(SessionMessage.Info),
  ),
  decodeSession = Schema.decodeUnknownEffect(Session.Info),
  /*
   * A host whose session API reads the root session, whose OpenAI
   * connection follows `script`, and which records each permission hook in
   * `registered`.
   */
  hostFor = (
    script: Script,
    registered: Ref.Ref<readonly Registered[]>,
  ): Effect.Effect<PluginHost> =>
    Effect.gen(function* fakeHost() {
      const info = yield* decodeSession(SESSION_INFO),
        messages = yield* decodeMessages(SESSION_MESSAGES)

      return {
        integration: {
          connection: {
            active: () =>
              Effect.succeed(
                Option.getOrUndefined(
                  Option.liftPredicate(
                    OPENAI_CONNECTION,
                    () => script.signedIn,
                  ),
                ),
              ),
            resolve: () =>
              Effect.succeed(
                support.oauthCredential(
                  support.jwt({ chatgpt_account_id: "acct-1" }),
                ),
              ),
          },
        },
        options: {},
        permission: {
          hook: (name: string, hook: Registered["hook"]) =>
            Ref.update(registered, Arr.append({ hook, name })).pipe(
              Effect.as(REGISTRATION),
            ),
        },
        session: {
          context: () => Effect.succeed(messages),
          get: () => Effect.succeed(info),
        },
      }
    }).pipe(Effect.orDie),
  /*
   * Sets the plugin up on a fake host that follows `script`. Returns the
   * names of the permission hooks setup registered, and a review that runs
   * the registered `evaluate` hooks on a prompt, with the network replaced
   * by the fake reviewer backend.
   */
  setUp = Effect.fn("test.setUp")(function* setUp(script: Script) {
    const fakeFetch: typeof globalThis.fetch = flow(
        () => Effect.sync(script.respond),
        Effect.runPromise,
      ),
      registered = yield* Ref.make<readonly Registered[]>([])

    yield* plugin.effect(yield* hostFor(script, registered))

    return {
      names: Ref.get(registered).pipe(
        Effect.map(Arr.map((entry) => entry.name)),
      ),
      review: (evaluation: PermissionEvaluation): Effect.Effect<void> =>
        Ref.get(registered).pipe(
          Effect.map(Arr.filter((entry) => entry.name === "evaluate")),
          Effect.map(Arr.map((entry) => entry.hook(evaluation))),
          Effect.flatMap((hooks: readonly Effect.Effect<void>[]) =>
            Effect.all(hooks, { discard: true }),
          ),
          Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
        ),
    }
  })

/** A fake host and reviewer backend for setup's registered permission hook. */
export default Object.freeze({
  askToPush,
  assessing,
  setUp,
  unavailableBackend: (): Response =>
    new Response("Service unavailable", { status: HTTP_UNAVAILABLE }),
})
