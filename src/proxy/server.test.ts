import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeCredentialsFile, resetCredentialCache, type ClaudeCredentials } from "./credentials"
import { createProxyServer } from "./server"
import { SYSTEM_IDENTITY } from "./transforms"
import { resetResolvedClaudeCodeVersion } from "./version"

const originalCredentialsPath = process.env.CLAUDE_PROXY_CREDENTIALS_PATH
const originalCliVersion = process.env.ANTHROPIC_CLI_VERSION
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
  globalThis.fetch = originalFetch
  resetCredentialCache()
  resetResolvedClaudeCodeVersion()
})

describe("server", () => {
  test("forwards transformed Anthropic requests with parity headers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "claude-max-proxy-server-"))
    const credentialsPath = join(tempDir, "credentials.json")
    process.env.CLAUDE_PROXY_CREDENTIALS_PATH = credentialsPath
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"

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
        "anthropic-beta": "client-beta",
        "x-api-key": "dummy"
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
    expect(seenHeaders.get("anthropic-beta")).toContain("client-beta")
    expect(seenHeaders.get("anthropic-beta")).toContain("prompt-caching-scope-2026-01-05")
    expect(seenHeaders.get("x-api-key")).toBeNull()

    const forwarded = JSON.parse(seenBody) as {
      system: Array<{ text?: string }>
      messages: Array<{ content?: string }>
      temperature?: number
    }
    expect(forwarded.system[0]?.text?.startsWith("x-anthropic-billing-header: ")).toBe(true)
    expect(forwarded.system[1]?.text).toBe(SYSTEM_IDENTITY)
    expect(forwarded.messages[0]?.content).toBe("Stay helpful\n\nhello world")
    expect(forwarded.temperature).toBeUndefined()
    expect(response.headers.get("content-encoding")).toBeNull()
  })
})
