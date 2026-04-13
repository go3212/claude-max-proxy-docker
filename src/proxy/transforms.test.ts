import { describe, expect, test } from "bun:test"
import {
  SYSTEM_IDENTITY,
  applyClaudeCodeRequestTransforms,
  transformBodyString,
  type AnthropicRequestBody
} from "./transforms"

function cloneBody<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe("transforms", () => {
  test("injects billing, keeps identity, and relocates extra system text", () => {
    const body: AnthropicRequestBody = {
      system: [
        {
          type: "text",
          text: `${SYSTEM_IDENTITY}\nStay helpful.`
        },
        {
          type: "text",
          text: "Extra system guidance"
        }
      ],
      messages: [
        {
          role: "user",
          content: "hello world"
        }
      ],
      model: "claude-opus-4-6-20260101",
      temperature: 0.2
    }

    const transformed = applyClaudeCodeRequestTransforms(cloneBody(body), {
      version: "2.1.104",
      entrypoint: "cli"
    })

    const system = transformed.system as Array<{ text?: string }>
    expect(system).toHaveLength(2)
    expect(system[0]?.text?.startsWith("x-anthropic-billing-header: ")).toBe(true)
    expect(system[1]?.text).toBe(SYSTEM_IDENTITY)
    expect(transformed.messages?.[0]?.content).toEqual([
      {
        type: "text",
        text:
          "<system-reminder>\nStay helpful.\n</system-reminder>\n\n" +
          "<system-reminder>\nExtra system guidance\n</system-reminder>\n\n" +
          "hello world"
      }
    ])
    expect(transformed.temperature).toBeUndefined()
  })

  test("injects the identity when the request does not already contain it", () => {
    const body: AnthropicRequestBody = {
      system: "plain system",
      messages: [
        {
          role: "user",
          content: "hello world"
        }
      ],
      model: "claude-sonnet-4-5-20250929"
    }

    const transformed = applyClaudeCodeRequestTransforms(cloneBody(body), {
      version: "2.1.104",
      entrypoint: "cli"
    })

    const system = transformed.system as Array<{ text?: string }>
    expect(system[0]?.text?.startsWith("x-anthropic-billing-header: ")).toBe(true)
    expect(system[1]?.text).toBe(SYSTEM_IDENTITY)
    expect(transformed.messages?.[0]?.content).toEqual([
      {
        type: "text",
        text:
          "<system-reminder>\nplain system\n</system-reminder>\n\nhello world"
      }
    ])
  })

  test("preserves non-text user blocks when relocating system text", () => {
    const body: AnthropicRequestBody = {
      system: "plain system",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", data: "abc" } },
            { type: "text", text: "hello world" }
          ]
        }
      ],
      model: "claude-sonnet-4-5-20250929"
    }

    const transformed = applyClaudeCodeRequestTransforms(cloneBody(body), {
      version: "2.1.104",
      entrypoint: "cli"
    })

    const content = transformed.messages?.[0]?.content
    expect(Array.isArray(content)).toBe(true)
    expect((content as Array<{ type?: string }>)[0]?.type).toBe("image")
    expect((content as Array<{ type?: string; text?: string }>)[1]?.text).toBe(
      "<system-reminder>\nplain system\n</system-reminder>\n\nhello world"
    )
  })

  test("is idempotent for billing and identity entries", () => {
    const once = applyClaudeCodeRequestTransforms({
      system: "plain system",
      messages: [{ role: "user", content: "hello world" }],
      model: "claude-sonnet-4-5-20250929"
    }, {
      version: "2.1.104",
      entrypoint: "cli"
    })

    const twice = applyClaudeCodeRequestTransforms(cloneBody(once), {
      version: "2.1.104",
      entrypoint: "cli"
    })

    const system = twice.system as Array<{ text?: string }>
    expect(system).toHaveLength(2)
    expect(system[1]?.text).toBe(SYSTEM_IDENTITY)
    expect(twice.messages).toEqual(once.messages)
  })

  test("strips unsupported effort fields for haiku models", () => {
    const transformed = applyClaudeCodeRequestTransforms({
      system: "plain system",
      messages: [{ role: "user", content: "hello world" }],
      model: "claude-haiku-4-5-20251001",
      output_config: { effort: "high" },
      thinking: { effort: "high" }
    }, {
      version: "2.1.104",
      entrypoint: "cli"
    })

    expect(transformed.output_config).toBeUndefined()
    expect(transformed.thinking).toBeUndefined()
  })

  test("preserves non-text system entries while reducing text system entries to core only", () => {
    const transformed = applyClaudeCodeRequestTransforms({
      system: [
        "plain system",
        {
          type: "metadata",
          source: "preserve-me"
        }
      ],
      messages: [{ role: "user", content: "hello world" }],
      model: "claude-sonnet-4-5-20250929"
    }, {
      version: "2.1.104",
      entrypoint: "cli"
    })

    const system = transformed.system as Array<{ type?: string; text?: string; source?: string }>
    expect(system[0]?.text?.startsWith("x-anthropic-billing-header: ")).toBe(true)
    expect(system[1]?.text).toBe(SYSTEM_IDENTITY)
    expect(system[2]).toEqual({ type: "metadata", source: "preserve-me" })
  })

  test("summarizes the transformed request shape without leaking prompt text", () => {
    const result = transformBodyString(JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      system: "plain system",
      messages: [{ role: "user", content: "hello world" }]
    }), {
      version: "2.1.104",
      entrypoint: "cli"
    })

    expect(result.summary).toEqual({
      movedSystemTextCount: 1,
      hadFirstUserMessage: true,
      hadFirstUserTextBlock: true,
      finalSystemTextCount: 2,
      textSystemReducedToCoreOnly: true
    })
    expect(JSON.stringify(result.summary)).not.toContain("plain system")
    expect(JSON.stringify(result.summary)).not.toContain("hello world")
  })
})
