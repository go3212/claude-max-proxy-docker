import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeCredentialsFile, resetCredentialCache, type ClaudeCredentials } from "./credentials"
import { createProxyServer } from "./server"
import { SYSTEM_IDENTITY } from "./transforms"
import { resetResolvedClaudeCodeVersion } from "./version"

const originalCredentialsPath = process.env.CLAUDE_PROXY_CREDENTIALS_PATH
const originalCliVersion = process.env.ANTHROPIC_CLI_VERSION
const originalCapturePath = process.env.CLAUDE_PROXY_CAPTURE_PATH
const originalProxyDebug = process.env.CLAUDE_PROXY_DEBUG
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
  globalThis.fetch = originalFetch
  resetCredentialCache()
  resetResolvedClaudeCodeVersion()
})

describe("server", () => {
  test("forwards transformed Anthropic requests with parity headers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "claude-max-proxy-server-"))
    const credentialsPath = join(tempDir, "credentials.json")
    const capturePath = join(tempDir, "latest-request.json")
    process.env.CLAUDE_PROXY_CREDENTIALS_PATH = credentialsPath
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"
    process.env.CLAUDE_PROXY_CAPTURE_PATH = capturePath

    const credentials: ClaudeCredentials = {
      claudeAiOauth: {
        accessToken: "server-access",
        refreshToken: "server-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000
      }
    }
    writeCredentialsFile(credentials, credentialsPath)

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
    expect(seenUrl).toBe("https://api.anthropic.com/v1/messages")
    expect(seenHeaders.get("authorization")).toBe("Bearer server-access")
    expect(seenHeaders.get("user-agent")).toBe("claude-cli/9.9.9 (external, cli)")
    expect(seenHeaders.get("anthropic-beta")).not.toContain("client-beta")
    expect(seenHeaders.get("anthropic-beta")).not.toContain("structured-outputs-2025-11-13")
    expect(seenHeaders.get("anthropic-beta")).toContain("prompt-caching-scope-2026-01-05")
    expect(seenHeaders.get("x-session-affinity")).toBeNull()
    expect(seenHeaders.get("accept")).toBeNull()
    expect(seenHeaders.get("x-api-key")).toBeNull()

    const forwarded = JSON.parse(seenBody) as {
      system: Array<{ text?: string }>
      messages: Array<{ content?: Array<{ type?: string; text?: string }> }>
      temperature?: number
    }
    expect(forwarded.system[0]?.text?.startsWith("x-anthropic-billing-header: ")).toBe(true)
    expect(forwarded.system[1]?.text).toBe(SYSTEM_IDENTITY)
    expect(forwarded.messages[0]?.content).toEqual([
      {
        type: "text",
        text: "<system-reminder>\nStay helpful\n</system-reminder>\n\nhello world"
      }
    ])
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
        outboundRequest: {
          headers: Record<string, string>
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
    expect(captured.proxy.outboundRequest.headers["x-app"]).toBe("cli")
    expect(captured.proxy.outboundRequest.droppedIncomingHeaders).toContain("x-session-affinity")
    expect(captured.proxy.outboundRequest.droppedIncomingBetas).toEqual([
      "client-beta",
      "structured-outputs-2025-11-13"
    ])
    expect(captured.proxy.summary.textSystemReducedToCoreOnly).toBe(true)
  })

  test("summarizes streamed upstream errors in debug logs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "claude-max-proxy-stream-error-"))
    const credentialsPath = join(tempDir, "credentials.json")
    process.env.CLAUDE_PROXY_CREDENTIALS_PATH = credentialsPath
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"
    process.env.CLAUDE_PROXY_DEBUG = "1"

    const credentials: ClaudeCredentials = {
      claudeAiOauth: {
        accessToken: "server-access",
        refreshToken: "server-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000
      }
    }
    writeCredentialsFile(credentials, credentialsPath)

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
})
