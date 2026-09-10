import type { Credential } from "@opencode-ai/plugin"
import type {
  SessionContext,
  SessionHttpRequest,
} from "@opencode-ai/plugin/promise/session"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  aliasRequestBody,
  buildClaudeHeaders,
  buildRequestFromSnapshot,
  restoreResponseToolNames,
  restoreToolNames,
  SYSTEM_IDENTITY,
  transformContext,
  transformRequest,
} from "./transforms.ts"

function oauth(access = "access"): Credential.OAuth {
  return {
    type: "oauth",
    methodID: "claude-code" as Credential.OAuth["methodID"],
    access,
    refresh: "refresh",
    expires: Date.now() + 3600_000,
    metadata: {},
  }
}

function contextEvent(): SessionContext {
  const read = { description: "Read files", input: { type: "object" } }
  const edit = { description: "Edit files", input: { type: "object" } }
  return {
    sessionID: "session" as never,
    agent: "build" as never,
    model: { providerID: "anthropic", id: "claude-sonnet-4-5" } as never,
    system: [
      { type: "text", text: "Use read before edit." },
      { type: "text", text: "Keep changes focused." },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Update the file" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", id: "one", name: "read", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "one",
            name: "read",
            result: { type: "text", value: "contents" },
          },
        ],
      },
    ],
    tools: { read, edit },
  } as unknown as SessionContext
}

describe("semantic context transform", () => {
  it("adds separate billing and identity parts and relocates system text", () => {
    const event = contextEvent()
    transformContext(event)
    assert.equal(event.system.length, 2)
    assert.match(event.system[0].text, /^x-anthropic-billing-header:/)
    assert.equal(event.system[1].text, SYSTEM_IDENTITY)
    const first = event.messages[0].content[0]
    assert.equal(first.type, "text")
    if (first.type !== "text") return
    assert.match(first.text, /Use read before edit/)
    assert.match(first.text, /read -> mcp_Read/)
    assert.match(first.text, /edit -> mcp_Edit/)
  })

  it("leaves the tool registry and call history on OpenCode's own names", () => {
    const event = contextEvent()
    const read = event.tools.read
    transformContext(event)
    assert.equal(event.tools.read, read)
    assert.equal(event.tools.mcp_Read, undefined)
    assert.equal(
      (event.messages[1].content[0] as { name: string }).name,
      "read",
    )
    assert.equal(
      (event.messages[2].content[0] as { name: string }).name,
      "read",
    )
  })

  it("is idempotent", () => {
    const event = contextEvent()
    transformContext(event)
    const first = JSON.stringify(event)
    transformContext(event)
    assert.equal(JSON.stringify(event), first)
  })
})

describe("native request transform", () => {
  it("merges required headers, preserves custom headers, and removes x-api-key", () => {
    const headers = buildClaudeHeaders(
      {
        "anthropic-beta": "custom-beta,oauth-2025-04-20",
        "x-api-key": "key",
        "x-custom": "keep",
      },
      "access",
      "claude-opus-4-6",
    )
    assert.equal(headers.get("authorization"), "Bearer access")
    assert.equal(headers.get("x-api-key"), null)
    assert.equal(headers.get("x-custom"), "keep")
    assert.equal(headers.get("anthropic-version"), "2023-06-01")
    assert.match(headers.get("anthropic-beta") ?? "", /custom-beta/)
    assert.match(headers.get("anthropic-beta") ?? "", /effort-2025-11-24/)
    assert.equal(
      headers.get("anthropic-dangerous-direct-browser-access"),
      "true",
    )
  })

  it("buffers independent bodies for the original request and two retries", async () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    const event = {
      sessionID: "session",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      request: new Request("https://api.anthropic.com/v1/messages?existing=1", {
        method: "POST",
        headers: { "content-type": "application/json", "x-custom": "keep" },
        body,
        redirect: "manual",
      }),
    } as unknown as SessionHttpRequest

    const transformed = await transformRequest(event, oauth("first"))
    const retryOne = buildRequestFromSnapshot(
      transformed.snapshot,
      oauth("second"),
    )
    const retryTwo = buildRequestFromSnapshot(
      transformed.snapshot,
      oauth("third"),
    )

    assert.deepEqual(
      await Promise.all([
        transformed.request.text(),
        retryOne.text(),
        retryTwo.text(),
      ]),
      [body, body, body],
    )
    assert.equal(
      new URL(transformed.request.url).searchParams.get("beta"),
      "true",
    )
    assert.equal(
      new URL(transformed.request.url).searchParams.get("existing"),
      "1",
    )
    assert.equal(retryOne.headers.get("authorization"), "Bearer second")
    assert.equal(retryTwo.headers.get("authorization"), "Bearer third")
    assert.equal(retryOne.headers.get("x-custom"), "keep")
    assert.equal(retryOne.redirect, "manual")
    assert.notEqual(
      retryOne.headers.get("x-client-request-id"),
      retryTwo.headers.get("x-client-request-id"),
    )
  })

  it("does not overwrite an existing beta query parameter", async () => {
    const event = {
      model: { id: "claude-sonnet-4-5" },
      request: new Request("https://api.anthropic.com/v1/messages?beta=false"),
    } as unknown as SessionHttpRequest
    const transformed = await transformRequest(event, oauth())
    assert.equal(
      new URL(transformed.request.url).searchParams.get("beta"),
      "false",
    )
  })
})

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function decode(body: Uint8Array): Record<string, never> {
  return JSON.parse(new TextDecoder().decode(body))
}

async function readAll(response: Response): Promise<string> {
  return await response.text()
}

function sse(events: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

describe("wire tool aliases", () => {
  it("aliases client tools, tool choice, and tool_use history", () => {
    const aliased = aliasRequestBody(
      encode({
        tools: [
          { name: "shell", input_schema: {} },
          { type: "custom", name: "read", input_schema: {} },
          { type: "web_search_20250305", name: "web_search" },
        ],
        tool_choice: { type: "tool", name: "shell" },
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "one", name: "grep", input: {} }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "one", content: "hit" },
            ],
          },
        ],
      }),
    )
    const payload = decode(aliased.body) as never as {
      tools: Array<{ name: string }>
      tool_choice: { name: string }
      messages: Array<{ content: Array<Record<string, string>> }>
    }
    assert.deepEqual(
      payload.tools.map((tool) => tool.name),
      ["mcp_Shell", "mcp_Read", "web_search"],
    )
    assert.equal(payload.tool_choice.name, "mcp_Shell")
    assert.equal(payload.messages[0].content[0].name, "mcp_Grep")
    assert.equal(payload.messages[1].content[0].tool_use_id, "one")
    assert.deepEqual(aliased.toolNames, {
      mcp_Shell: "shell",
      mcp_Read: "read",
      mcp_Grep: "grep",
    })
  })

  it("passes through bodies with nothing to alias", () => {
    const plain = new TextEncoder().encode("complete-body")
    assert.equal(aliasRequestBody(plain).body, plain)

    const noTools = encode({ messages: [{ role: "user", content: "hi" }] })
    const result = aliasRequestBody(noTools)
    assert.equal(result.body, noTools)
    assert.deepEqual(result.toolNames, {})

    const alreadyAliased = aliasRequestBody(
      encode({ tools: [{ name: "mcp_Playwright_click" }] }),
    )
    assert.deepEqual(alreadyAliased.toolNames, {})
  })

  it("restores only aliases this plugin applied", () => {
    const restored = restoreToolNames(
      '{"name":"mcp_Shell"} {"name": "mcp_Playwright_click"}',
      { mcp_Shell: "shell" },
    )
    assert.equal(restored, '{"name":"shell"} {"name": "mcp_Playwright_click"}')
  })

  it("rewrites a streamed tool call split across chunks", async () => {
    const response = restoreResponseToolNames(
      sse([
        'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"one","na',
        'me":"mcp_Shell"}}\n\nevent: content_block_delta\ndata: {"delta":{"text":"done"}}\n\n',
      ]),
      { mcp_Shell: "shell" },
    )
    const text = await readAll(response)
    assert.match(text, /"name":"shell"/)
    assert.doesNotMatch(text, /mcp_Shell/)
    assert.match(text, /"text":"done"/)
  })

  it("leaves responses without aliases untouched", async () => {
    const original = new Response("body", { status: 429 })
    assert.equal(restoreResponseToolNames(original, {}), original)
  })

  it("carries the aliases on the snapshot for retries", async () => {
    const event = {
      model: { id: "claude-sonnet-4-5" },
      request: new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ tools: [{ name: "shell" }] }),
      }),
    } as unknown as SessionHttpRequest
    const transformed = await transformRequest(event, oauth())
    assert.deepEqual(transformed.snapshot.toolNames, { mcp_Shell: "shell" })
    assert.match(await transformed.request.text(), /"mcp_Shell"/)
    assert.match(
      await buildRequestFromSnapshot(transformed.snapshot, oauth()).text(),
      /"mcp_Shell"/,
    )
  })
})
