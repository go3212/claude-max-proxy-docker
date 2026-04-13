import { describe, expect, test } from "bun:test"
import {
  applyRequestToolBridge,
  rewriteResponseJsonToolNames,
  rewriteSseBodyToolNames
} from "./tool-bridge"

describe("tool bridge", () => {
  test("normalizes built-ins and dynamic MCP tool names in hermes-minimal mode", () => {
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
          name: "webfetch",
          input_schema: { type: "object" }
        }
      ],
      tool_choice: {
        type: "tool",
        name: "975393dc_1af9a18e_validation_preview"
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
            }
          ]
        }
      ]
    }

    const bridge = applyRequestToolBridge(body, "drop")

    expect((body.tools as Array<{ name?: string }>).map((tool) => tool.name)).toEqual([
      "Bash",
      "mcp__environment__get_environment",
      "mcp__975393dc_1af9a18e__validation_preview"
    ])
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: "mcp__975393dc_1af9a18e__validation_preview"
    })
    expect((body.messages as Array<{ content?: Array<{ name?: string }> }>)[0]?.content?.[0]?.name).toBe(
      "mcp__environment__get_environment"
    )
    expect(bridge.mappedToolNames).toEqual([
      { openName: "bash", officialName: "Bash" },
      {
        openName: "__environment_get_environment",
        officialName: "mcp__environment__get_environment"
      },
      {
        openName: "975393dc_1af9a18e_validation_preview",
        officialName: "mcp__975393dc_1af9a18e__validation_preview"
      }
    ])
    expect(bridge.unsupportedToolNames).toEqual(["webfetch"])
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
        }
      ]
    }
    const bridge = applyRequestToolBridge(body, "drop")

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
        }
      ]
    }, bridge.officialToOpenNames) as {
      content: Array<{ name?: string }>
    }

    expect(rewritten.content.map((block) => block.name)).toEqual([
      "__environment_get_environment",
      "975393dc_1af9a18e_validation_preview"
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
        }
      ]
    }
    const bridge = applyRequestToolBridge(body, "drop")
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
        controller.close()
      }
    })

    const rewritten = await new Response(
      rewriteSseBodyToolNames(sseBody, bridge.officialToOpenNames)
    ).text()

    expect(rewritten).toContain('"name":"__environment_get_environment"')
    expect(rewritten).toContain('"name":"975393dc_1af9a18e_validation_preview"')
    expect(rewritten).not.toContain('"name":"mcp__environment__get_environment"')
    expect(rewritten).not.toContain('"name":"mcp__975393dc_1af9a18e__validation_preview"')
  })
})
