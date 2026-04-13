import { afterEach, describe, expect, test } from "bun:test"
import { buildRequestHeaders } from "./headers"

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
  test("builds Claude Code parity headers and merges incoming betas", () => {
    delete process.env.ANTHROPIC_USER_AGENT
    delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT
    delete process.env.ANTHROPIC_BETA_FLAGS

    const first = buildRequestHeaders(
      new Headers({
        "anthropic-beta": "custom-beta,oauth-2025-04-20",
        "x-api-key": "dummy"
      }),
      "token-123",
      "claude-opus-4-6-20260101",
      "9.9.9"
    )

    const second = buildRequestHeaders(
      new Headers(),
      "token-123",
      "claude-opus-4-6-20260101",
      "9.9.9"
    )

    const betas = (first.get("anthropic-beta") ?? "").split(",")
    expect(first.get("authorization")).toBe("Bearer token-123")
    expect(first.get("user-agent")).toBe("claude-cli/9.9.9 (external, cli)")
    expect(first.get("x-app")).toBe("cli")
    expect(first.get("x-api-key")).toBeNull()
    expect(first.get("x-client-request-id")).toBeTruthy()
    expect(first.get("x-claude-code-session-id")).toBe(second.get("x-claude-code-session-id"))
    expect(betas).toContain("custom-beta")
    expect(betas).toContain("prompt-caching-scope-2026-01-05")
    expect(betas).toContain("effort-2025-11-24")
  })

  test("drops interleaved thinking for haiku and adds 1m context when enabled", () => {
    delete process.env.ANTHROPIC_USER_AGENT
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true"

    const headers = buildRequestHeaders(
      new Headers(),
      "token-123",
      "claude-haiku-4-5-20251001",
      "9.9.9"
    )

    const betas = (headers.get("anthropic-beta") ?? "").split(",")
    expect(betas).not.toContain("interleaved-thinking-2025-05-14")
    expect(betas).not.toContain("context-1m-2025-08-07")
  })

  test("honors a full user-agent override", () => {
    process.env.ANTHROPIC_USER_AGENT = "custom-agent/1.0"

    const headers = buildRequestHeaders(
      new Headers(),
      "token-123",
      "claude-sonnet-4-6-20260101",
      "9.9.9"
    )

    expect(headers.get("user-agent")).toBe("custom-agent/1.0")
  })
})
