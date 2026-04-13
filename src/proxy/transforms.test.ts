import { describe, expect, test } from "bun:test"
import {
  SYSTEM_IDENTITY,
  applyClaudeCodeRequestTransforms,
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
    expect(transformed.messages?.[0]?.content).toBe(
      "Stay helpful.\n\nExtra system guidance\n\nhello world"
    )
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
    expect(transformed.messages?.[0]?.content).toBe("plain system\n\nhello world")
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
    expect((content as Array<{ type?: string; text?: string }>)[0]?.text).toBe("plain system")
    expect((content as Array<{ type?: string }>)[1]?.type).toBe("image")
    expect((content as Array<{ type?: string; text?: string }>)[2]?.text).toBe("hello world")
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
})
