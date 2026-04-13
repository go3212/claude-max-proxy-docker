import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  getValidCredentials,
  parseOAuthResponse,
  resetCredentialCache,
  writeCredentialsFile,
  type ClaudeCredentials
} from "./credentials"

const originalCredentialsPath = process.env.CLAUDE_PROXY_CREDENTIALS_PATH
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
  globalThis.fetch = originalFetch
  resetCredentialCache()
})

function buildCredentials(expiresAt: number): ClaudeCredentials {
  return {
    claudeAiOauth: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
      subscriptionType: "max"
    }
  }
}

describe("credentials", () => {
  test("parses an OAuth refresh response", () => {
    const parsed = parseOAuthResponse(
      JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 120
      }),
      buildCredentials(0),
      1_000
    )

    expect(parsed?.claudeAiOauth.accessToken).toBe("new-access")
    expect(parsed?.claudeAiOauth.refreshToken).toBe("new-refresh")
    expect(parsed?.claudeAiOauth.expiresAt).toBe(121_000)
    expect(parsed?.claudeAiOauth.subscriptionType).toBe("max")
  })

  test("refreshes expired credentials and writes them back to disk", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "claude-max-proxy-"))
    const credentialsPath = join(tempDir, "credentials.json")
    process.env.CLAUDE_PROXY_CREDENTIALS_PATH = credentialsPath
    writeCredentialsFile(buildCredentials(Date.now() - 1_000), credentialsPath)

    let refreshCalls = 0
    globalThis.fetch = (async (input, init) => {
      refreshCalls += 1
      expect(String(input)).toBe("https://claude.ai/v1/oauth/token")
      expect(init?.method).toBe("POST")
      return new Response(JSON.stringify({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 120
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }) as typeof fetch

    const credentials = await getValidCredentials()
    const written = JSON.parse(readFileSync(credentialsPath, "utf-8")) as ClaudeCredentials

    expect(refreshCalls).toBe(1)
    expect(credentials.claudeAiOauth.accessToken).toBe("fresh-access")
    expect(written.claudeAiOauth.refreshToken).toBe("fresh-refresh")
  })
})
