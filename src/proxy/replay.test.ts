import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildCapturedRequestFixture, writeCapturedRequestFixture } from "./capture"
import { writeCredentialsFile, resetCredentialCache, type ClaudeCredentials } from "./credentials"
import { resetOfficialClaudeScaffoldCache } from "./official-scaffold"
import { runCapturedRequestValidation } from "./replay"
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
  resetOfficialClaudeScaffoldCache()
})

describe("replay validation", () => {
  test("fails clearly when the capture fixture is missing", async () => {
    await expect(
      runCapturedRequestValidation("C:\\missing\\capture.json")
    ).rejects.toThrow("Failed to read capture fixture")
  })

  test("replays a captured request and flags the known third-party usage classification", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "claude-max-proxy-replay-"))
    const credentialsPath = join(tempDir, "credentials.json")
    const capturePath = join(tempDir, "latest-request.json")
    process.env.CLAUDE_PROXY_CREDENTIALS_PATH = credentialsPath
    process.env.ANTHROPIC_CLI_VERSION = "2.1.104"

    const credentials: ClaudeCredentials = {
      claudeAiOauth: {
        accessToken: "server-access",
        refreshToken: "server-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000
      }
    }
    writeCredentialsFile(credentials, credentialsPath)

    const fixture = buildCapturedRequestFixture({
      method: "POST",
      path: "/messages",
      headers: new Headers({
        "content-type": "application/json",
        "anthropic-beta": "client-beta,structured-outputs-2025-11-13",
        "x-session-affinity": "ses_123"
      }),
      rawBody: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        stream: true,
        tool_choice: {
          type: "auto"
        },
        system: "Stay helpful",
        messages: [{ role: "user", content: "hello world" }],
        tools: [
          {
            name: "bash",
            description: "Run bash",
            input_schema: {
              type: "object",
              properties: {
                command: {
                  type: "string"
                }
              },
              required: ["command"],
              additionalProperties: false
            }
          }
        ]
      }),
      claudeCodeVersion: "2.1.104",
      entrypoint: "cli",
      modelId: "claude-sonnet-4-5-20250929",
      stream: true,
      transformed: true,
      betas: ["prompt-caching-scope-2026-01-05"],
      summary: {
        movedSystemTextCount: 1,
        hadFirstUserMessage: true,
        hadFirstUserTextBlock: true,
        finalSystemTextCount: 2,
        textSystemReducedToCoreOnly: true
      },
      outgoingHeaders: new Headers({
        authorization: "Bearer secret",
        "anthropic-beta": "prompt-caching-scope-2026-01-05",
        "x-app": "cli"
      }),
      outgoingBody: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        stream: true,
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=2.1.104.abc; cc_entrypoint=cli; cch=12345;"
          }
        ],
        messages: [{ role: "user", content: "hello world" }]
      }),
      droppedIncomingHeaders: ["x-session-affinity"],
      droppedIncomingBetas: ["client-beta", "structured-outputs-2025-11-13"]
    })
    await writeCapturedRequestFixture(capturePath, fixture)

    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: {
        message:
          "Third-party apps now draw from your extra usage, not your plan limits. " +
          "We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going."
      }
    }), {
      status: 400,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch

    const result = await runCapturedRequestValidation(capturePath)

    expect(result.status).toBe(400)
    expect(result.model).toBe("claude-sonnet-4-5-20250929")
    expect(result.summary.isThirdPartyUsage).toBe(true)
    expect(result.accepted).toBe(false)
    expect(result.excerpt).toContain("Third-party apps now draw")
  })
})
