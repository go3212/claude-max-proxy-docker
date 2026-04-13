import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeCredentialsFile, resetCredentialCache, type ClaudeCredentials } from "./credentials"
import { createProxyServer } from "./server"
import { SYSTEM_IDENTITY } from "./transforms"
import { resetResolvedClaudeCodeVersion } from "./version"
import { resetOfficialClaudeScaffoldCache } from "./official-scaffold"

const originalCredentialsPath = process.env.CLAUDE_PROXY_CREDENTIALS_PATH
const originalCliVersion = process.env.ANTHROPIC_CLI_VERSION
const originalCapturePath = process.env.CLAUDE_PROXY_CAPTURE_PATH
const originalProxyDebug = process.env.CLAUDE_PROXY_DEBUG
const originalOfficialCapturePath = process.env.CLAUDE_PROXY_OFFICIAL_CAPTURE_RAW_PATH
const originalBetaFlags = process.env.ANTHROPIC_BETA_FLAGS
const originalEnable1m = process.env.ANTHROPIC_ENABLE_1M_CONTEXT
const originalUserAgent = process.env.ANTHROPIC_USER_AGENT
const originalSystemMode = process.env.CLAUDE_PROXY_SYSTEM_MODE
const originalFetch = globalThis.fetch

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

afterEach(() => {
  restoreEnv("CLAUDE_PROXY_CREDENTIALS_PATH", originalCredentialsPath)
  restoreEnv("ANTHROPIC_CLI_VERSION", originalCliVersion)
  restoreEnv("CLAUDE_PROXY_CAPTURE_PATH", originalCapturePath)
  restoreEnv("CLAUDE_PROXY_DEBUG", originalProxyDebug)
  restoreEnv("CLAUDE_PROXY_OFFICIAL_CAPTURE_RAW_PATH", originalOfficialCapturePath)
  restoreEnv("ANTHROPIC_BETA_FLAGS", originalBetaFlags)
  restoreEnv("ANTHROPIC_ENABLE_1M_CONTEXT", originalEnable1m)
  restoreEnv("ANTHROPIC_USER_AGENT", originalUserAgent)
  restoreEnv("CLAUDE_PROXY_SYSTEM_MODE", originalSystemMode)
  globalThis.fetch = originalFetch
  resetCredentialCache()
  resetResolvedClaudeCodeVersion()
  resetOfficialClaudeScaffoldCache()
})

describe("server", () => {
  test("forwards transformed Anthropic requests with parity headers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "claude-max-proxy-server-"))
    const credentialsPath = join(tempDir, "credentials.json")
    const capturePath = join(tempDir, "latest-request.json")
    const officialCapturePath = join(tempDir, "official-raw.json")
    process.env.CLAUDE_PROXY_CREDENTIALS_PATH = credentialsPath
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"
    process.env.CLAUDE_PROXY_CAPTURE_PATH = capturePath
    process.env.CLAUDE_PROXY_OFFICIAL_CAPTURE_RAW_PATH = officialCapturePath
    delete process.env.ANTHROPIC_BETA_FLAGS
    delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT
    delete process.env.ANTHROPIC_USER_AGENT
    delete process.env.CLAUDE_PROXY_SYSTEM_MODE

    const credentials: ClaudeCredentials = {
      claudeAiOauth: {
        accessToken: "server-access",
        refreshToken: "server-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000
      }
    }
    writeCredentialsFile(credentials, credentialsPath)
    writeFileSync(officialCapturePath, JSON.stringify({
      schemaVersion: 1,
      capturedAt: "2026-04-13T11:29:40.428Z",
      runtime: {
        transport: "fetch",
        binaryPath: "/usr/bin/claude"
      },
      request: {
        url: "https://api.anthropic.com/v1/messages?beta=true",
        method: "POST",
        headers: {
          accept: "application/json",
          "anthropic-beta":
            "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-version": "2023-06-01",
          authorization: "Bearer raw-secret",
          "content-type": "application/json",
          "user-agent": "claude-cli/2.1.104 (external, sdk-cli)",
          "x-app": "cli",
          "x-claude-code-session-id": "session-id",
          "x-client-request-id": "request-id",
          "x-stainless-arch": "x64",
          "x-stainless-lang": "js",
          "x-stainless-os": "Linux",
          "x-stainless-package-version": "0.81.0",
          "x-stainless-retry-count": "0",
          "x-stainless-runtime": "node",
          "x-stainless-runtime-version": "v24.14.1",
          "x-stainless-timeout": "600"
        },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Official prompt wrapper" }
              ]
            }
          ],
          system: [
            { type: "text", text: "x-anthropic-billing-header: old" },
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
          metadata: {
            user_id: "official-user"
          },
          context_management: {
            edits: [
              {
                type: "clear_thinking_20251015",
                keep: "summary"
              }
            ]
          },
          tools: [
            {
              name: "Bash",
              description: "Run shell commands",
              input_schema: {
                type: "object"
              }
            }
          ],
          output_config: {
            effort: "medium"
          },
          stream: true
        })
      }
    }, null, 2), "utf-8")

    let seenUrl = ""
    let seenHeaders = new Headers()
    let seenBody = ""

    globalThis.fetch = (async (input, init) => {
      seenUrl = String(input)
      seenHeaders = new Headers(init?.headers)
      seenBody = String(init?.body ?? "")

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip"
        }
      })
    }) as typeof fetch

    resetResolvedClaudeCodeVersion()
    const { app } = createProxyServer()
    const response = await app.request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "client-beta,structured-outputs-2025-11-13",
        "x-api-key": "dummy",
        "x-session-affinity": "ses_123",
        accept: "*/*"
      },
      body: JSON.stringify({
        model: "claude-opus-4-6-20260101",
        system: "Stay helpful",
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: "hello world"
          }
        ]
      })
    })

    expect(response.status).toBe(200)
    expect(seenUrl).toBe("https://api.anthropic.com/v1/messages?beta=true")
    expect(seenHeaders.get("authorization")).toBe("Bearer server-access")
    expect(seenHeaders.get("user-agent")).toBe("claude-cli/9.9.9 (external, sdk-cli)")
    expect(seenHeaders.get("anthropic-beta")).not.toContain("client-beta")
    expect(seenHeaders.get("anthropic-beta")).not.toContain("structured-outputs-2025-11-13")
    expect(seenHeaders.get("anthropic-beta")).toContain("prompt-caching-scope-2026-01-05")
    expect(seenHeaders.get("anthropic-dangerous-direct-browser-access")).toBe("true")
    expect(seenHeaders.get("x-stainless-package-version")).toBe("0.81.0")
    expect(seenHeaders.get("x-session-affinity")).toBeNull()
    expect(seenHeaders.get("accept")).toBe("application/json")
    expect(seenHeaders.get("x-api-key")).toBeNull()

    const forwarded = JSON.parse(seenBody) as {
      system: Array<{ text?: string }>
      messages: Array<{ content?: Array<{ type?: string; text?: string }> }>
      metadata?: { user_id?: string }
      context_management?: unknown
      temperature?: number
    }
    expect(forwarded.system[0]?.text?.startsWith("x-anthropic-billing-header: ")).toBe(true)
    expect(forwarded.system[1]?.text).toBe(SYSTEM_IDENTITY)
    expect(forwarded.system[2]?.text).toBe("Official scaffold A")
    expect(forwarded.messages[0]?.content).toEqual([
      {
        type: "text",
        text: "<system-reminder>\nStay helpful\n</system-reminder>\n\nhello world"
      }
    ])
    expect(forwarded.metadata?.user_id).toBe("official-user")
    expect(forwarded.context_management).toEqual({
      edits: [
        {
          type: "clear_thinking_20251015",
          keep: "summary"
        }
      ]
    })
    expect(forwarded.temperature).toBeUndefined()
    expect(response.headers.get("content-encoding")).toBeNull()

    const captured = JSON.parse(readFileSync(capturePath, "utf-8")) as {
      request: {
        headers: Record<string, string>
        body: {
          system: string
          messages: Array<{ role: string; content: string }>
        }
      }
      proxy: {
        systemMode: string
        mappedTools: Array<{ openName: string; officialName: string }>
        unsupportedToolNames: string[]
        outboundRequest: {
          headers: Record<string, string>
          body: {
            system: Array<{ text?: string }>
            messages: Array<{ content?: Array<{ type?: string; text?: string }> }>
          }
          droppedIncomingHeaders: string[]
          droppedIncomingBetas: string[]
        }
        summary: {
          textSystemReducedToCoreOnly: boolean
        }
      }
    }
    expect(captured.request.headers["x-session-affinity"]).toMatch(/\[redacted-header-\d+\]/)
    expect(captured.request.body.system).toMatch(/\[redacted-system-1\]/)
    expect(JSON.stringify(captured.request.body)).not.toContain("x-anthropic-billing-header")
    expect(captured.request.body.messages[0]?.role).toBe("user")
    expect(captured.request.body.messages[0]?.content).toMatch(/\[redacted-user-1\]/)
    expect(captured.proxy.outboundRequest.headers.authorization).toBe("[redacted-header-1]")
    expect(captured.proxy.outboundRequest.body.system[0]?.text?.startsWith("[redacted-system-")).toBe(true)
    expect(captured.proxy.outboundRequest.body.messages[0]?.content?.[0]?.type).toBe("text")
    expect(captured.proxy.outboundRequest.headers["x-app"]).toBe("cli")
    expect(captured.proxy.outboundRequest.headers["accept"]).toBe("application/json")
    expect(captured.proxy.systemMode).toBe("official")
    expect(captured.proxy.mappedTools).toEqual([])
    expect(captured.proxy.unsupportedToolNames).toEqual([])
    expect(captured.proxy.outboundRequest.droppedIncomingHeaders).toContain("x-session-affinity")
    expect(captured.proxy.outboundRequest.droppedIncomingBetas).toEqual([
      "client-beta",
      "structured-outputs-2025-11-13"
    ])
    expect(captured.proxy.summary.textSystemReducedToCoreOnly).toBe(false)
  })

  test("summarizes streamed upstream errors in debug logs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "claude-max-proxy-stream-error-"))
    const credentialsPath = join(tempDir, "credentials.json")
    const officialCapturePath = join(tempDir, "official-raw.json")
    process.env.CLAUDE_PROXY_CREDENTIALS_PATH = credentialsPath
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"
    process.env.CLAUDE_PROXY_DEBUG = "1"
    process.env.CLAUDE_PROXY_OFFICIAL_CAPTURE_RAW_PATH = officialCapturePath
    delete process.env.ANTHROPIC_BETA_FLAGS
    delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT
    delete process.env.ANTHROPIC_USER_AGENT
    delete process.env.CLAUDE_PROXY_SYSTEM_MODE

    const credentials: ClaudeCredentials = {
      claudeAiOauth: {
        accessToken: "server-access",
        refreshToken: "server-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000
      }
    }
    writeCredentialsFile(credentials, credentialsPath)
    writeFileSync(officialCapturePath, JSON.stringify({
      schemaVersion: 1,
      capturedAt: "2026-04-13T11:29:40.428Z",
      runtime: {
        transport: "fetch"
      },
      request: {
        url: "https://api.anthropic.com/v1/messages?beta=true",
        method: "POST",
        headers: {
          accept: "application/json",
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,prompt-caching-scope-2026-01-05",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "user-agent": "claude-cli/2.1.104 (external, sdk-cli)",
          "x-app": "cli"
        },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          messages: [
            { role: "user", content: [{ type: "text", text: "Official prompt wrapper" }] }
          ],
          system: [
            { type: "text", text: "x-anthropic-billing-header: old" },
            { type: "text", text: SYSTEM_IDENTITY }
          ],
          stream: true
        })
      }
    }, null, 2), "utf-8")

    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: {
        message:
          "Third-party apps now draw from your extra usage, not your plan limits. " +
          "We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going."
      }
    }), {
      status: 400,
      headers: {
        "content-type": "application/json"
      }
    })) as unknown as typeof fetch

    const logMessages: string[] = []
    const debug = mock((message?: unknown) => {
      logMessages.push(String(message ?? ""))
    })
    const originalDebug = console.debug
    console.debug = debug

    try {
      resetResolvedClaudeCodeVersion()
      const { app } = createProxyServer()
      const response = await app.request("http://localhost/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          stream: true,
          messages: [
            {
              role: "user",
              content: "hello world"
            }
          ]
        })
      })

      expect(response.status).toBe(400)
      const logLines = logMessages.join("\n")
      expect(logLines).toContain("proxy.response")
      expect(logLines).toContain("thirdPartyUsageDetected")
      expect(logLines).toContain("Third-party apps now draw")
    } finally {
      console.debug = originalDebug
    }
  })

  test("retries once without unsupported tools and rewrites official tool names in streamed responses", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "claude-max-proxy-tool-retry-"))
    const credentialsPath = join(tempDir, "credentials.json")
    const officialCapturePath = join(tempDir, "official-raw.json")
    process.env.CLAUDE_PROXY_CREDENTIALS_PATH = credentialsPath
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"
    process.env.CLAUDE_PROXY_OFFICIAL_CAPTURE_RAW_PATH = officialCapturePath
    delete process.env.ANTHROPIC_BETA_FLAGS
    delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT
    delete process.env.ANTHROPIC_USER_AGENT
    delete process.env.CLAUDE_PROXY_SYSTEM_MODE

    const credentials: ClaudeCredentials = {
      claudeAiOauth: {
        accessToken: "server-access",
        refreshToken: "server-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000
      }
    }
    writeCredentialsFile(credentials, credentialsPath)
    writeFileSync(officialCapturePath, JSON.stringify({
      schemaVersion: 1,
      capturedAt: "2026-04-13T11:29:40.428Z",
      runtime: {
        transport: "fetch"
      },
      request: {
        url: "https://api.anthropic.com/v1/messages?beta=true",
        method: "POST",
        headers: {
          accept: "application/json",
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "user-agent": "claude-cli/2.1.104 (external, sdk-cli)",
          "x-app": "cli"
        },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          messages: [
            { role: "user", content: [{ type: "text", text: "Official prompt wrapper" }] }
          ],
          system: [
            { type: "text", text: "x-anthropic-billing-header: old" },
            { type: "text", text: SYSTEM_IDENTITY }
          ],
          tools: [
            {
              name: "Bash",
              description: "Run shell commands",
              input_schema: {
                type: "object"
              }
            }
          ],
          stream: true
        })
      }
    }, null, 2), "utf-8")

    const seenBodies: Array<{ tools?: Array<{ name?: string }> }> = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seenBodies.push(JSON.parse(String(init?.body ?? "{}")) as { tools?: Array<{ name?: string }> })

      if (seenBodies.length === 1) {
        return new Response(JSON.stringify({
          error: {
            message:
              "Third-party apps now draw from your extra usage, not your plan limits. " +
              "We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going."
          }
        }), {
          status: 400,
          headers: { "content-type": "application/json" }
        })
      }

      return new Response(
        [
          "event: content_block_start",
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}',
          "",
          "event: content_block_delta",
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}',
          "",
          "event: content_block_stop",
          'data: {"type":"content_block_stop","index":0}',
          ""
        ].join("\n"),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8"
          }
        }
      )
    }) as unknown as typeof fetch

    resetResolvedClaudeCodeVersion()
    const { app } = createProxyServer()
    const response = await app.request("http://localhost/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        stream: true,
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
      })
    })

    const body = await response.text()

    expect(response.status).toBe(200)
    expect(seenBodies).toHaveLength(2)
    expect(seenBodies[0]?.tools?.map((tool) => tool.name)).toEqual(["Bash", "question"])
    expect(seenBodies[1]?.tools?.map((tool) => tool.name)).toEqual(["Bash"])
    expect(body).toContain('"name":"bash"')
    expect(body).not.toContain('"name":"Bash"')
  })

  test("uses hermes-minimal mode to reduce system and drop unsupported tools immediately", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "claude-max-proxy-hermes-minimal-"))
    const credentialsPath = join(tempDir, "credentials.json")
    const officialCapturePath = join(tempDir, "official-raw.json")
    process.env.CLAUDE_PROXY_CREDENTIALS_PATH = credentialsPath
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"
    process.env.CLAUDE_PROXY_OFFICIAL_CAPTURE_RAW_PATH = officialCapturePath
    process.env.CLAUDE_PROXY_SYSTEM_MODE = "hermes-minimal"
    delete process.env.ANTHROPIC_BETA_FLAGS
    delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT
    delete process.env.ANTHROPIC_USER_AGENT

    const credentials: ClaudeCredentials = {
      claudeAiOauth: {
        accessToken: "server-access",
        refreshToken: "server-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000
      }
    }
    writeCredentialsFile(credentials, credentialsPath)
    writeFileSync(officialCapturePath, JSON.stringify({
      schemaVersion: 1,
      capturedAt: "2026-04-13T11:29:40.428Z",
      runtime: {
        transport: "fetch"
      },
      request: {
        url: "https://api.anthropic.com/v1/messages?beta=true",
        method: "POST",
        headers: {
          accept: "application/json",
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "user-agent": "claude-cli/2.1.104 (external, sdk-cli)",
          "x-app": "cli"
        },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          messages: [{ role: "user", content: [{ type: "text", text: "Official prompt wrapper" }] }],
          system: [
            { type: "text", text: "x-anthropic-billing-header: old" },
            { type: "text", text: SYSTEM_IDENTITY },
            { type: "text", text: "Official scaffold A" }
          ],
          stream: true
        })
      }
    }, null, 2), "utf-8")

    let seenBody = ""
    globalThis.fetch = (async (_input, init) => {
      seenBody = String(init?.body ?? "")
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
    }) as typeof fetch

    resetResolvedClaudeCodeVersion()
    const { app } = createProxyServer()
    const response = await app.request("http://localhost/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        stream: true,
        system: "Stay helpful",
        messages: [{ role: "user", content: "hello world" }],
        tools: [
          {
            name: "bash",
            description: "Run bash",
            input_schema: { type: "object" }
          },
          {
            name: "github__list_issues",
            description: "List issues",
            input_schema: { type: "object" }
          },
          {
            name: "question",
            description: "Ask a question",
            input_schema: { type: "object" }
          }
        ]
      })
    })

    const forwarded = JSON.parse(seenBody) as {
      system: Array<{ text?: string }>
      tools: Array<{ name?: string }>
      messages: Array<{ content?: Array<{ type?: string; text?: string }> }>
    }

    expect(response.status).toBe(200)
    expect(forwarded.system).toHaveLength(2)
    expect(forwarded.system[0]?.text?.startsWith("x-anthropic-billing-header: ")).toBe(true)
    expect(forwarded.system[1]?.text).toBe(SYSTEM_IDENTITY)
    expect(forwarded.tools.map((tool) => tool.name)).toEqual([
      "Bash",
      "mcp__github__list_issues"
    ])
    expect(forwarded.messages[0]?.content).toEqual([
      {
        type: "text",
        text: "<system-reminder>\nStay helpful\n</system-reminder>\n\nhello world"
      }
    ])
  })
})
