import { describe, expect, test } from "bun:test"
import {
  SYSTEM_IDENTITY,
  applyClaudeCodeRequestTransforms,
  transformBodyString,
  type AnthropicRequestBody
} from "./transforms"
import type { OfficialClaudeScaffold } from "./official-scaffold"
import type { TransformOptions } from "./transforms"

function cloneBody<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function createScaffold(): OfficialClaudeScaffold {
  return {
    source: "raw-capture",
    capturePath: "/captures/official-claude/latest-raw.json",
    upstreamUrl: "https://api.anthropic.com/v1/messages?beta=true",
    path: "/v1/messages",
    query: "?beta=true",
    entrypoint: "sdk-cli",
    headerTemplate: {
      "anthropic-beta":
        "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24"
    },
    bodyTemplate: {
      system: [
        { type: "text", text: SYSTEM_IDENTITY },
        { type: "text", text: "Official scaffold A" },
        {
          type: "text",
          text: "Official scaffold B",
          cache_control: {
            type: "ephemeral",
            ttl: "5m",
            scope: "workspace"
          }
        },
        { type: "text", text: "Official scaffold C" }
      ],
      context_management: {
        edits: [
          {
            type: "clear_thinking_20251015",
            keep: "summary"
          }
        ]
      },
      metadata: {
        user_id: "official-user"
      },
      tools: [
        {
          name: "Bash",
          description: "Run shell commands",
          input_schema: {
            type: "object",
            properties: {
              command: { type: "string" }
            }
          }
        }
      ],
      stream: true
    }
  }
}

function createTransformOptions(
  systemMode: "official" | "hermes-minimal" = "official"
): TransformOptions {
  return {
    version: "2.1.104",
    entrypoint: "sdk-cli",
    scaffold: createScaffold(),
    systemMode
  }
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

    const transformed = applyClaudeCodeRequestTransforms(cloneBody(body), createTransformOptions())

    const system = transformed.system as Array<{ text?: string }>
    expect(system).toHaveLength(5)
    expect(system[0]?.text?.startsWith("x-anthropic-billing-header: ")).toBe(true)
    expect(system[1]?.text).toBe(SYSTEM_IDENTITY)
    expect(system[2]?.text).toBe("Official scaffold A")
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
    expect(transformed.context_management).toEqual(createScaffold().bodyTemplate.context_management)
    expect(transformed.metadata).toEqual({ user_id: "official-user" })
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

    const transformed = applyClaudeCodeRequestTransforms(cloneBody(body), createTransformOptions())

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

    const transformed = applyClaudeCodeRequestTransforms(cloneBody(body), createTransformOptions())

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
    }, createTransformOptions())

    const twice = applyClaudeCodeRequestTransforms(cloneBody(once), createTransformOptions())

    const system = twice.system as Array<{ text?: string }>
    expect(system).toHaveLength(5)
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
    }, createTransformOptions())

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
    }, createTransformOptions())

    const system = transformed.system as Array<{ type?: string; text?: string; source?: string }>
    expect(system[0]?.text?.startsWith("x-anthropic-billing-header: ")).toBe(true)
    expect(system[1]?.text).toBe(SYSTEM_IDENTITY)
    expect(system[5]).toEqual({ type: "metadata", source: "preserve-me" })
  })

  test("summarizes the transformed request shape without leaking prompt text", () => {
    const result = transformBodyString(JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      system: "plain system",
      messages: [{ role: "user", content: "hello world" }]
    }), createTransformOptions())

    expect(result.summary).toEqual({
      movedSystemTextCount: 1,
      hadFirstUserMessage: true,
      hadFirstUserTextBlock: true,
      finalSystemTextCount: 5,
      textSystemReducedToCoreOnly: false
    })
    expect(JSON.stringify(result.summary)).not.toContain("plain system")
    expect(JSON.stringify(result.summary)).not.toContain("hello world")
  })

  test("renames supported tools to official Claude tool names while keeping unsupported ones on the first attempt", () => {
    const result = transformBodyString(JSON.stringify({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "hello world" }],
      tools: [
        {
          name: "bash",
          description: "Run bash",
          input_schema: {
            type: "object",
            properties: {
              command: { type: "string" }
            }
          }
        },
        {
          name: "question",
          description: "Ask a question",
          input_schema: {
            type: "object"
          }
        }
      ]
    }), createTransformOptions())

    const transformed = JSON.parse(result.body) as { tools: Array<{ name?: string; description?: string }> }
    expect(transformed.tools[0]?.name).toBe("Bash")
    expect(transformed.tools[0]?.description).toBe("Run bash")
    expect(transformed.tools[1]?.name).toBe("question")
    expect(result.toolBridge.mappedToolNames).toEqual([{ openName: "bash", officialName: "Bash" }])
    expect(result.toolBridge.unsupportedToolNames).toEqual(["question"])
  })

  test("reduces system to billing and identity only in hermes-minimal mode", () => {
    const transformed = applyClaudeCodeRequestTransforms({
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
      messages: [{ role: "user", content: "hello world" }],
      model: "claude-opus-4-6-20260101"
    }, createTransformOptions("hermes-minimal"))

    const system = transformed.system as Array<{ type?: string; text?: string }>
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
  })

  test("normalizes plain tools to local MCP names in hermes-minimal mode", () => {
    const result = transformBodyString(JSON.stringify({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "hello world" }],
      tools: [
        {
          name: "bash",
          description: "Run bash",
          input_schema: { type: "object" }
        },
        {
          name: "question",
          description: "Ask a question",
          input_schema: { type: "object" }
        },
        {
          name: "webfetch",
          description: "Fetch a URL",
          input_schema: { type: "object" }
        },
        {
          name: "todowrite",
          description: "Write todos",
          input_schema: { type: "object" }
        },
        {
          name: "get_environment",
          description: "Get environment",
          input_schema: { type: "object" }
        },
        {
          name: "__environment_get_environment",
          description: "Read environment",
          input_schema: { type: "object" }
        },
        {
          name: "975393dc_1af9a18e_validation_preview",
          description: "Validation preview",
          input_schema: { type: "object" }
        }
      ]
    }), {
      ...createTransformOptions("hermes-minimal"),
      unsupportedToolMode: "drop"
    })

    const transformed = JSON.parse(result.body) as { tools: Array<{ name?: string }> }
    expect(transformed.tools.map((tool) => tool.name)).toEqual([
      "Bash",
      "mcp__local__question",
      "mcp__local__webfetch",
      "mcp__local__todowrite",
      "mcp__environment__get_environment",
      "mcp__environment__get_environment",
      "mcp__975393dc_1af9a18e__validation_preview"
    ])
    expect(result.toolBridge.mappedToolNames).toEqual([
      { openName: "bash", officialName: "Bash" },
      {
        openName: "question",
        officialName: "mcp__local__question"
      },
      {
        openName: "webfetch",
        officialName: "mcp__local__webfetch"
      },
      {
        openName: "todowrite",
        officialName: "mcp__local__todowrite"
      },
      {
        openName: "get_environment",
        officialName: "mcp__environment__get_environment"
      },
      {
        openName: "__environment_get_environment",
        officialName: "mcp__environment__get_environment"
      },
      {
        openName: "975393dc_1af9a18e_validation_preview",
        officialName: "mcp__975393dc_1af9a18e__validation_preview"
      }
    ])
    expect(result.toolBridge.unsupportedToolNames).toEqual([])
  })
})
