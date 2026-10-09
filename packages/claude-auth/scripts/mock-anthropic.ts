import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { json } from "node:stream/consumers"
import { config } from "../dist/model-config.js"
import { SYSTEM_IDENTITY } from "../dist/transforms.js"

/**
 * Betas every request must carry, written out rather than read from the
 * plugin, which is the thing under test. The effort beta depends on the
 * model, so it is left to the unit tests.
 */
const REQUIRED_WIRE_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  "context-management-2025-06-27",
  "advisor-tool-2026-03-01",
  "thinking-token-count-2026-05-13",
  "extended-cache-ttl-2025-04-11",
]

/** The parts of a Messages API request the mock reads. */
interface MessageRequest {
  model: string
  stream?: boolean
  system: Array<{ text: string }>
  messages: Array<{ content: unknown }>
  tools?: Array<{ name: string }>
}

/** Every content block of `type` across the request's messages. */
function blocksOfType(
  messages: MessageRequest["messages"],
  type: string,
): Array<{ type: string; name?: string }> {
  return messages
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter((block: { type: string }) => block.type === type)
}

/** Local Messages API fixture: never contacts Anthropic or reads credentials. */
export async function startMockAnthropic(sentinel: string, file: string) {
  const failures: unknown[] = []
  let toolCalls = 0
  let toolResults = 0
  const server = createServer(async (request, response) => {
    try {
      assert.equal(
        new URL(request.url ?? "", "http://localhost").pathname,
        "/v1/messages",
      )
      assert.equal(request.headers.authorization, "Bearer offline-test-access")
      assert.equal(request.headers["x-api-key"], undefined)
      assert.equal(
        request.headers["user-agent"],
        `claude-cli/${config.ccVersion} (external, sdk-cli)`,
      )
      const body = (await json(request)) as MessageRequest
      const betas = String(request.headers["anthropic-beta"]).split(",")
      for (const beta of REQUIRED_WIRE_BETAS) {
        assert.ok(betas.includes(beta), beta)
      }
      assert.match(body.system[0].text, /^x-anthropic-billing-header:/)
      assert.ok(body.system[0].text.includes(`cc_version=${config.ccVersion}.`))
      assert.ok(body.system[0].text.includes("cch=00000;"))
      assert.equal(body.system[1].text, SYSTEM_IDENTITY)
      const primary = request.headers["x-claude-auth-test-kind"] === "primary"
      const results = blocksOfType(body.messages, "tool_result")
      const read = body.tools?.find((tool) => tool.name === "mcp_Read")
      if (primary) assert.ok(read, "read tool was not aliased")
      const useTool = primary && results.length === 0
      const content = useTool
        ? {
            type: "tool_use",
            id: "tool_mock_read",
            name: "mcp_Read",
            input: { path: file },
          }
        : { type: "text", text: primary ? sentinel : "Offline smoke test" }
      if (useTool) toolCalls++
      if (primary && results.length > 0) {
        toolResults++
        assert.ok(
          JSON.stringify(results).includes(sentinel),
          "read result missing sentinel",
        )
        assert.ok(
          blocksOfType(body.messages, "tool_use").some(
            (block) => block.name === "mcp_Read",
          ),
        )
      }
      const message = {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [content],
        stop_reason: useTool ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      }
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(message))
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      const emit = (type: string, data: object) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        )
      emit("message_start", {
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      })
      emit("content_block_start", {
        index: 0,
        content_block: useTool
          ? { ...content, input: {} }
          : { type: "text", text: "" },
      })
      emit("content_block_delta", {
        index: 0,
        delta: useTool
          ? {
              type: "input_json_delta",
              partial_json: JSON.stringify({ path: file }),
            }
          : { type: "text_delta", text: content.text },
      })
      emit("content_block_stop", { index: 0 })
      emit("message_delta", {
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: 10 },
      })
      emit("message_stop", {})
      response.end()
    } catch (error) {
      failures.push(error)
      response.writeHead(400, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: String(error) },
        }),
      )
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    verify() {
      assert.deepEqual(failures, [])
      assert.ok(toolCalls > 0, "no tool call reached the mock")
      assert.ok(toolResults > 0, "no tool result reached the mock")
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
