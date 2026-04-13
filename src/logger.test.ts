import { afterEach, describe, expect, mock, test } from "bun:test"
import { claudeLog, isDebugLoggingEnabled } from "./logger"

const originalProxyDebug = process.env.CLAUDE_PROXY_DEBUG
const originalLegacyDebug = process.env.OPENCODE_CLAUDE_PROVIDER_DEBUG

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }

  process.env[name] = value
}

afterEach(() => {
  restoreEnv("CLAUDE_PROXY_DEBUG", originalProxyDebug)
  restoreEnv("OPENCODE_CLAUDE_PROVIDER_DEBUG", originalLegacyDebug)
})

describe("logger", () => {
  test("enables logging with the canonical proxy debug flag", () => {
    process.env.CLAUDE_PROXY_DEBUG = "1"
    delete process.env.OPENCODE_CLAUDE_PROVIDER_DEBUG

    expect(isDebugLoggingEnabled()).toBe(true)
  })

  test("keeps the legacy debug flag as a compatibility alias", () => {
    delete process.env.CLAUDE_PROXY_DEBUG
    process.env.OPENCODE_CLAUDE_PROVIDER_DEBUG = "1"

    expect(isDebugLoggingEnabled()).toBe(true)
  })

  test("does not emit logs when both debug flags are disabled", () => {
    delete process.env.CLAUDE_PROXY_DEBUG
    delete process.env.OPENCODE_CLAUDE_PROVIDER_DEBUG

    const debug = mock(() => {})
    const originalDebug = console.debug
    console.debug = debug

    try {
      claudeLog("proxy.request", { ok: true })
      expect(debug).not.toHaveBeenCalled()
    } finally {
      console.debug = originalDebug
    }
  })
})
