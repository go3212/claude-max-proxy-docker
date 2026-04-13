import { describe, expect, test } from "bun:test"
import {
  applyRequestToolBridge,
  rewriteResponseJsonToolNames,
  rewriteSseBodyToolNames
} from "./tool-bridge"

describe("tool bridge", () => {
  test("keeps plain extra tools unsupported outside hermes-minimal mode", () => {
    const body: Record<string, unknown> = {
      tools: [
        {
          name: "question",
          input_schema: { type: "object" }
        },
        {
          name: "webfetch",
          input_schema: { type: "object" }
        }
      ],
      tool_choice: {
        type: "tool",
        name: "question"
      }
    }

    const bridge = applyRequestToolBridge(body, "keep", "official")

    expect((body.tools as Array<{ name?: string }>).map((tool) => tool.name)).toEqual([
      "question",
      "webfetch"
    ])
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: "question"
    })
    expect(bridge.mappedToolNames).toEqual([])
    expect(bridge.unsupportedToolNames).toEqual(["question", "webfetch"])
  })

  test("normalizes built-ins, aliases, dynamic MCP tools, and local fallbacks in hermes-minimal mode", () => {
    const body: Record<string, unknown> = {
      tools: [
        {
          name: "bash",
          input_schema: { type: "object" }
        },
        {
          name: "__environment_get_environment",
          input_schema: { type: "object" }
        },
        {
          name: "975393dc_1af9a18e_validation_preview",
          input_schema: { type: "object" }
        },
        {
          name: "get_environment",
          input_schema: { type: "object" }
        },
        {
          name: "question",
          input_schema: { type: "object" }
        },
        {
          name: "webfetch",
          input_schema: { type: "object" }
        },
        {
          name: "todowrite",
          input_schema: { type: "object" }
        }
      ],
      tool_choice: {
        type: "tool",
        name: "question"
      },
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "__environment_get_environment",
              input: {}
            },
            {
              type: "tool_use",
              id: "toolu_2",
              name: "question",
              input: {}
            }
          ]
        }
      ]
    }

    const bridge = applyRequestToolBridge(body, "drop", "hermes-minimal")

    expect((body.tools as Array<{ name?: string }>).map((tool) => tool.name)).toEqual([
      "Bash",
      "mcp__environment__get_environment",
      "mcp__975393dc_1af9a18e__validation_preview",
      "mcp__environment__get_environment",
      "mcp__local__question",
      "mcp__local__webfetch",
      "mcp__local__todowrite"
    ])
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: "mcp__local__question"
    })
    expect((body.messages as Array<{ content?: Array<{ name?: string }> }>)[0]?.content?.map((block) => block.name)).toEqual([
      "mcp__environment__get_environment",
      "mcp__local__question"
    ])
    expect(bridge.mappedToolNames).toEqual([
      { openName: "bash", officialName: "Bash" },
      {
        openName: "__environment_get_environment",
        officialName: "mcp__environment__get_environment"
      },
      {
        openName: "975393dc_1af9a18e_validation_preview",
        officialName: "mcp__975393dc_1af9a18e__validation_preview"
      },
      {
        openName: "get_environment",
        officialName: "mcp__environment__get_environment"
      },
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
      }
    ])
    expect(bridge.unsupportedToolNames).toEqual([])
  })

  test("rewrites official MCP tool names back to the original client names in JSON payloads", () => {
    const body: Record<string, unknown> = {
      tools: [
        {
          name: "__environment_get_environment",
          input_schema: { type: "object" }
        },
        {
          name: "975393dc_1af9a18e_validation_preview",
          input_schema: { type: "object" }
        },
        {
          name: "question",
          input_schema: { type: "object" }
        },
        {
          name: "webfetch",
          input_schema: { type: "object" }
        }
      ]
    }
    const bridge = applyRequestToolBridge(body, "drop", "hermes-minimal")

    const rewritten = rewriteResponseJsonToolNames({
      type: "message",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "mcp__environment__get_environment",
          input: {}
        },
        {
          type: "tool_use",
          id: "toolu_2",
          name: "mcp__975393dc_1af9a18e__validation_preview",
          input: {}
        },
        {
          type: "tool_use",
          id: "toolu_3",
          name: "mcp__local__question",
          input: {}
        },
        {
          type: "tool_use",
          id: "toolu_4",
          name: "mcp__local__webfetch",
          input: {}
        }
      ]
    }, bridge.officialToOpenNames) as {
      content: Array<{ name?: string }>
    }

    expect(rewritten.content.map((block) => block.name)).toEqual([
      "__environment_get_environment",
      "975393dc_1af9a18e_validation_preview",
      "question",
      "webfetch"
    ])
  })

  test("rewrites official MCP tool names back to the original client names in SSE payloads", async () => {
    const body: Record<string, unknown> = {
      tools: [
        {
          name: "__environment_get_environment",
          input_schema: { type: "object" }
        },
        {
          name: "975393dc_1af9a18e_validation_preview",
          input_schema: { type: "object" }
        },
        {
          name: "question",
          input_schema: { type: "object" }
        }
      ]
    }
    const bridge = applyRequestToolBridge(body, "drop", "hermes-minimal")
    const encoder = new TextEncoder()
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          "event: content_block_start\n" +
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp__environment__get_environment","input":{}}}' +
          "\n\n"
        ))
        controller.enqueue(encoder.encode(
          "event: content_block_start\n" +
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"mcp__975393dc_1af9a18e__validation_preview","input":{}}}' +
          "\n\n"
        ))
        controller.enqueue(encoder.encode(
          "event: content_block_start\n" +
          'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_3","name":"mcp__local__question","input":{}}}' +
          "\n\n"
        ))
        controller.close()
      }
    })

    const rewritten = await new Response(
      rewriteSseBodyToolNames(sseBody, bridge.officialToOpenNames)
    ).text()

    expect(rewritten).toContain('"name":"__environment_get_environment"')
    expect(rewritten).toContain('"name":"975393dc_1af9a18e_validation_preview"')
    expect(rewritten).toContain('"name":"question"')
    expect(rewritten).not.toContain('"name":"mcp__environment__get_environment"')
    expect(rewritten).not.toContain('"name":"mcp__975393dc_1af9a18e__validation_preview"')
    expect(rewritten).not.toContain('"name":"mcp__local__question"')
  })
})
