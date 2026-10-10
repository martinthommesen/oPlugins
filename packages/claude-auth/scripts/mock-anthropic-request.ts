import { Array as Arr, Option, Predicate, Schema } from "effect"
import modelConfig from "#src/model-config.ts"
import sessionContext from "#src/session-context.ts"

type Turn = typeof MessageRequest.Type

type Block = typeof ContentBlock.Type

// One content block, with the fields the mock reads.
const ContentBlock = Schema.Struct({
    content: Schema.optionalKey(Schema.Unknown),
    name: Schema.optionalKey(Schema.String),
    type: Schema.String,
  }),
  /** The tools a request offers. */
  DeclaredTools = Schema.Array(Schema.Struct({ name: Schema.String })),
  FIRST = 0,
  MESSAGES_PATH = "/v1/messages",
  /** A message's content: text, or content blocks. */
  MessageContent = Schema.Union([Schema.String, Schema.Array(ContentBlock)]),
  /** The parts of a Messages API request the mock reads. */
  MessageRequest = Schema.Struct({
    messages: Schema.Array(Schema.Struct({ content: MessageContent })),
    model: Schema.String,
    stream: Schema.optionalKey(Schema.Boolean),
    system: Schema.Array(Schema.Struct({ text: Schema.String })),
    tools: Schema.optionalKey(DeclaredTools),
  }),
  NO_BLOCKS = 0,
  OFFLINE_AUTHORIZATION = "Bearer offline-test-access",
  READ_ALIAS = "mcp_Read",
  /**
   * Betas every request must carry, written out rather than read from the
   * plugin, which is the thing under test. The effort beta depends on the
   * model, so it is left to the unit tests.
   */
  REQUIRED_WIRE_BETAS = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
    "thinking-token-count-2026-05-13",
    "extended-cache-ttl-2025-04-11",
  ],
  SECOND = 1,
  /** The request headers the mock checks. */
  WireHeaders = Schema.Struct({
    "anthropic-beta": Schema.optionalKey(Schema.String),
    authorization: Schema.optionalKey(Schema.String),
    "user-agent": Schema.optionalKey(Schema.String),
    "x-api-key": Schema.optionalKey(Schema.String),
    "x-claude-auth-test-kind": Schema.optionalKey(Schema.String),
  }),
  /* No failure when `passed`, else `failure`. */
  asFailure = (passed: boolean, failure: string): readonly string[] => {
    if (passed) {
      return []
    }

    return [failure]
  },
  /*
   * The failures of the checks on the system prompt of a request: the
   * billing header, then Claude Code's identity.
   */
  billingFailures = (turn: Turn): readonly string[] => {
    const billing = Option.match(Arr.get(turn.system, FIRST), {
        onNone: () => "",
        onSome: (part) => part.text,
      }),
      identity = Arr.get(turn.system, SECOND)

    return [
      ...asFailure(
        billing.startsWith("x-anthropic-billing-header:"),
        "system[0] is not the billing header",
      ),
      ...asFailure(
        billing.includes(`cc_version=${modelConfig.ccVersion}.`),
        "billing header lacks the pinned cc_version",
      ),
      ...asFailure(
        billing.includes("cch=00000;"),
        "billing header lacks cch=00000;",
      ),
      ...asFailure(
        Option.exists(
          identity,
          (part) => part.text === sessionContext.systemIdentity,
        ),
        "system[1] is not the Claude Code identity",
      ),
    ]
  },
  /* Every content block of `type` across the request's messages. */
  blocksOfType = (messages: Turn["messages"], type: string): readonly Block[] =>
    messages
      .flatMap((message): readonly Block[] => {
        if (Predicate.isString(message.content)) {
          return []
        }

        return message.content
      })
      .filter((block) => block.type === type),
  /*
   * The failures of the checks on the body of a request. A primary request
   * must offer the read tool under its alias, and once the read has run,
   * carry its result and the aliased call that produced it.
   */
  bodyFailures = (
    turn: Turn,
    primary: boolean,
    sentinel: string,
  ): readonly string[] => {
    const results = blocksOfType(turn.messages, "tool_result"),
      returned = primary && results.length > NO_BLOCKS

    return [
      ...billingFailures(turn),
      ...asFailure(
        !primary || (turn.tools ?? []).some((tool) => tool.name === READ_ALIAS),
        "read tool was not aliased",
      ),
      ...asFailure(
        !returned || JSON.stringify(results).includes(sentinel),
        "read result missing sentinel",
      ),
      ...asFailure(
        !returned ||
          blocksOfType(turn.messages, "tool_use").some(
            (block) => block.name === READ_ALIAS,
          ),
        "read call in the history was not aliased",
      ),
    ]
  },
  /* The failures of the checks on the headers and path of a request. */
  headerFailures = (
    sent: typeof WireHeaders.Type,
    path: Option.Option<string>,
  ): readonly string[] => {
    const betas = (sent["anthropic-beta"] ?? "").split(",")

    return [
      ...asFailure(
        Option.contains(path, MESSAGES_PATH),
        `request path was ${Option.getOrElse(path, () => "unreadable")}`,
      ),
      ...asFailure(
        sent.authorization === OFFLINE_AUTHORIZATION,
        "authorization was not the offline test credential",
      ),
      ...asFailure(
        Predicate.isUndefined(sent["x-api-key"]),
        "x-api-key was sent",
      ),
      ...asFailure(
        sent["user-agent"] ===
          `claude-cli/${modelConfig.ccVersion} (external, sdk-cli)`,
        `user-agent was ${sent["user-agent"] ?? "missing"}`,
      ),
      ...REQUIRED_WIRE_BETAS.flatMap((beta) =>
        asFailure(betas.includes(beta), `anthropic-beta lacks ${beta}`),
      ),
    ]
  }

/** The Messages API requests the mock accepts, and the checks it makes. */
export default Object.freeze({
  MessageRequest,
  WireHeaders,
  blocksOfType,
  bodyFailures,
  headerFailures,
})
