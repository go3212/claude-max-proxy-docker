import { describe, expect, test } from "bun:test"
import type { CapturedRequestFixture } from "../proxy/capture"
import type { OfficialClaudeRedactedCapture } from "./capture"
import { diffOfficialClaudeAgainstProxy } from "./diff"

function createOfficialCapture(): OfficialClaudeRedactedCapture {
  return {
    schemaVersion: 1,
    capturedAt: "2026-04-13T00:00:00.000Z",
    runtime: {
      transport: "fetch",
      binaryPath: "/usr/bin/claude"
    },
    request: {
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "user-agent": "claude-cli/2.1.104 (external, cli)",
        "x-app": "cli",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20"
      },
      body: {
        model: "claude-opus-4-6",
        stream: true,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        system: [
          { type: "text", text: "x-anthropic-billing-header: normalized" },
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "[redacted-user-1]" }
            ]
          }
        ],
        tools: [
          {
            name: "bash",
            input_schema: {
              type: "object",
              properties: {
                command: { type: "string" }
              },
              required: ["command"],
              additionalProperties: false
            }
          }
        ],
        tool_choice: {
          type: "auto"
        }
      }
    }
  }
}

function createProxyFixture(): CapturedRequestFixture {
  return {
    schemaVersion: 1,
    capturedAt: "2026-04-13T00:00:00.000Z",
    request: {
      method: "POST",
      path: "/messages",
      headers: {
        "content-type": "application/json"
      },
      body: {}
    },
    proxy: {
      claudeCodeVersion: "2.1.104",
      entrypoint: "cli",
      systemMode: "official",
      modelId: "claude-opus-4-6",
      stream: true,
      transformed: true,
      betas: ["claude-code-20250219", "oauth-2025-04-20"],
      mappedTools: [],
      unsupportedToolNames: [],
      summary: {
        movedSystemTextCount: 1,
        hadFirstUserMessage: true,
        hadFirstUserTextBlock: true,
        finalSystemTextCount: 2,
        textSystemReducedToCoreOnly: true
      },
      outboundRequest: {
        headers: {
          "user-agent": "claude-cli/2.1.104 (external, cli)",
          "x-app": "cli",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20"
        },
        body: {
          model: "claude-opus-4-6",
          stream: true,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          system: [
            { type: "text", text: "x-anthropic-billing-header: normalized" },
            { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }
          ],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "[redacted-user-1]" }
              ]
            }
          ],
          tools: [
            {
              name: "bash",
              input_schema: {
                type: "object",
                properties: {
                  command: { type: "string" }
                },
                required: ["command"],
                additionalProperties: false
              }
            }
          ],
          tool_choice: {
            type: "auto"
          }
        },
        droppedIncomingHeaders: [],
        droppedIncomingBetas: []
      }
    }
  }
}

describe("official claude diff", () => {
  test("ignores dynamic request ids by comparing normalized captures only", () => {
    const diffs = diffOfficialClaudeAgainstProxy(
      createOfficialCapture(),
      createProxyFixture()
    )

    expect(diffs).toEqual([])
  })

  test("reports meaningful differences in official versus proxy identity", () => {
    const official = createOfficialCapture()
    const proxy = createProxyFixture()
    proxy.proxy.outboundRequest.headers["user-agent"] = "claude-cli/2.1.103 (external, cli)"
    proxy.proxy.outboundRequest.body = {
      ...(proxy.proxy.outboundRequest.body as Record<string, unknown>),
      tool_choice: { type: "none" }
    }

    const diffs = diffOfficialClaudeAgainstProxy(official, proxy)

    expect(diffs.some((diff) => diff.includes("headers.userAgent"))).toBe(true)
    expect(diffs.some((diff) => diff.includes("body.toolChoice.type"))).toBe(true)
  })
})
