import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  buildCapturedRequestFixture,
  readCapturedRequestFixture,
  sanitizeIncomingRequestBody,
  writeCapturedRequestFixture
} from "./capture"

describe("capture", () => {
  test("sanitizes prompt text, tokens, and binary payloads while preserving request structure", () => {
    const body = sanitizeIncomingRequestBody(JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      system: "Stay helpful",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
            { type: "text", text: "hello world" },
            { type: "tool_use", id: "toolu_123", name: "search_docs", input: { query: "secret phrase" } }
          ]
        }
      ],
      tools: [
        {
          name: "search_docs",
          description: "Search the private docs",
          input_schema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "A private user query"
              }
            }
          }
        }
      ],
      accessToken: "top-secret"
    }))

    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain("Stay helpful")
    expect(serialized).not.toContain("hello world")
    expect(serialized).not.toContain("secret phrase")
    expect(serialized).not.toContain("top-secret")
    expect(serialized).not.toContain("abc123")

    const typed = body as {
      model: string
      system: string
      messages: Array<{ role: string; content: Array<{ type?: string; source?: { data?: string }; id?: string; name?: string }> }>
      tools: Array<{ name: string; input_schema: { properties: { query: { type: string } } } }>
    }

    expect(typed.model).toBe("claude-sonnet-4-5-20250929")
    expect(typed.system).toMatch(/\[redacted-system-1\]/)
    expect(typed.messages[0]?.role).toBe("user")
    expect(typed.messages[0]?.content[0]?.type).toBe("image")
    expect(typed.messages[0]?.content[0]?.source?.data).toBe("[redacted-image-data]")
    expect(typed.messages[0]?.content[2]?.id).toBe("toolu_123")
    expect(typed.messages[0]?.content[2]?.name).toBe("search_docs")
    expect(typed.tools[0]?.name).toBe("search_docs")
    expect(typed.tools[0]?.input_schema.properties.query.type).toBe("string")
  })

  test("builds and reloads a redacted fixture with sanitized headers and transform metadata", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "claude-max-proxy-capture-"))
    const capturePath = join(tempDir, "latest-request.json")

    const fixture = buildCapturedRequestFixture({
      method: "POST",
      path: "/v1/messages",
      headers: new Headers({
        "content-type": "application/json",
        authorization: "Bearer secret",
        "x-api-key": "dummy"
      }),
      rawBody: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        system: "Stay helpful",
        messages: [{ role: "user", content: "hello world" }]
      }),
      claudeCodeVersion: "2.1.104",
      entrypoint: "cli",
      modelId: "claude-sonnet-4-5-20250929",
      stream: false,
      transformed: true,
      betas: ["prompt-caching-scope-2026-01-05"],
      summary: {
        movedSystemTextCount: 1,
        hadFirstUserMessage: true,
        hadFirstUserTextBlock: true,
        finalSystemTextCount: 2,
        textSystemReducedToCoreOnly: true
      }
    })

    await writeCapturedRequestFixture(capturePath, fixture)
    const reloaded = await readCapturedRequestFixture(capturePath)

    expect(reloaded.request.headers.authorization).toMatch(/\[redacted-header-1\]/)
    expect(reloaded.request.headers["x-api-key"]).toMatch(/\[redacted-header-2\]/)
    expect(JSON.stringify(reloaded.request.body)).not.toContain("hello world")
    expect(reloaded.proxy.summary.textSystemReducedToCoreOnly).toBe(true)
    expect(reloaded.proxy.betas).toEqual(["prompt-caching-scope-2026-01-05"])
  })
})
