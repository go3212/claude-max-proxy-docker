import { afterEach, describe, expect, test } from "bun:test"
import { prepareRequestHeaders } from "./headers"

const originalUserAgent = process.env.ANTHROPIC_USER_AGENT
const originalEnable1m = process.env.ANTHROPIC_ENABLE_1M_CONTEXT
const originalBetaFlags = process.env.ANTHROPIC_BETA_FLAGS

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

afterEach(() => {
  restoreEnv("ANTHROPIC_USER_AGENT", originalUserAgent)
  restoreEnv("ANTHROPIC_ENABLE_1M_CONTEXT", originalEnable1m)
  restoreEnv("ANTHROPIC_BETA_FLAGS", originalBetaFlags)
})

describe("headers", () => {
  test("builds Claude Code parity headers and drops non-Claude incoming betas and headers", () => {
    delete process.env.ANTHROPIC_USER_AGENT
    delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT
    delete process.env.ANTHROPIC_BETA_FLAGS

    const first = prepareRequestHeaders(
      new Headers({
        "anthropic-beta": "custom-beta,oauth-2025-04-20,structured-outputs-2025-11-13",
        "x-api-key": "dummy",
        "x-session-affinity": "ses_123",
        accept: "*/*"
      }),
      "token-123",
      "claude-opus-4-6-20260101",
      "9.9.9"
    )

    const second = prepareRequestHeaders(
      new Headers(),
      "token-123",
      "claude-opus-4-6-20260101",
      "9.9.9"
    )

    expect(first.headers.get("authorization")).toBe("Bearer token-123")
    expect(first.headers.get("user-agent")).toBe("claude-cli/9.9.9 (external, cli)")
    expect(first.headers.get("x-app")).toBe("cli")
    expect(first.headers.get("x-api-key")).toBeNull()
    expect(first.headers.get("x-session-affinity")).toBeNull()
    expect(first.headers.get("accept")).toBeNull()
    expect(first.headers.get("x-client-request-id")).toBeTruthy()
    expect(first.headers.get("x-claude-code-session-id")).toBe(second.headers.get("x-claude-code-session-id"))
    expect(first.debugHeaders.authorization).toBe("[redacted]")
    expect(first.betas).not.toContain("custom-beta")
    expect(first.betas).not.toContain("structured-outputs-2025-11-13")
    expect(first.betas).toContain("prompt-caching-scope-2026-01-05")
    expect(first.betas).toContain("effort-2025-11-24")
    expect(first.droppedIncomingBetas).toEqual([
      "custom-beta",
      "structured-outputs-2025-11-13"
    ])
    expect(first.droppedIncomingHeaders).toEqual([
      "accept",
      "x-api-key",
      "x-session-affinity"
    ])
  })

  test("drops interleaved thinking for haiku and adds 1m context when enabled", () => {
    delete process.env.ANTHROPIC_USER_AGENT
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true"

    const headerBuild = prepareRequestHeaders(
      new Headers(),
      "token-123",
      "claude-haiku-4-5-20251001",
      "9.9.9"
    )

    expect(headerBuild.betas).not.toContain("interleaved-thinking-2025-05-14")
    expect(headerBuild.betas).not.toContain("context-1m-2025-08-07")
  })

  test("honors a full user-agent override", () => {
    process.env.ANTHROPIC_USER_AGENT = "custom-agent/1.0"

    const headerBuild = prepareRequestHeaders(
      new Headers(),
      "token-123",
      "claude-sonnet-4-6-20260101",
      "9.9.9"
    )

    expect(headerBuild.headers.get("user-agent")).toBe("custom-agent/1.0")
  })
})
