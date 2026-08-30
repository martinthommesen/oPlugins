import type { Credential } from "@opencode-ai/plugin"
import type {
  SessionContext,
  SessionHttpRequest,
} from "@opencode-ai/plugin/promise/session"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildClaudeHeaders,
  buildRequestFromSnapshot,
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

  it("moves the exact tool definition object and aliases history", () => {
    const event = contextEvent()
    const read = event.tools.read
    transformContext(event)
    assert.equal(event.tools.read, undefined)
    assert.equal(event.tools.mcp_Read, read)
    assert.equal(event.messages[1].content[0].type, "tool-call")
    assert.equal(
      (event.messages[1].content[0] as { name: string }).name,
      "mcp_Read",
    )
    assert.equal(
      (event.messages[2].content[0] as { name: string }).name,
      "mcp_Read",
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
