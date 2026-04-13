import { describe, expect, test } from "bun:test"
import {
  buildValidationExcerpt,
  detectThirdPartyUsageClassification,
  summarizeAnthropicResponse
} from "./validation"

describe("validation", () => {
  test("detects the known third-party extra usage classification message", () => {
    const text =
      "Third-party apps now draw from your extra usage, not your plan limits. " +
      "We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going."

    expect(detectThirdPartyUsageClassification(text)).toBe(true)
  })

  test("summarizes an Anthropic error payload", () => {
    const summary = summarizeAnthropicResponse(JSON.stringify({
      error: {
        message:
          "Third-party apps now draw from your extra usage, not your plan limits."
      }
    }))

    expect(summary.errorMessage).toContain("Third-party apps now draw")
    expect(summary.isThirdPartyUsage).toBe(true)
  })

  test("summarizes an Anthropic assistant payload", () => {
    const summary = summarizeAnthropicResponse(JSON.stringify({
      content: [
        { type: "text", text: "OK" }
      ]
    }))

    expect(summary.assistantText).toBe("OK")
    expect(summary.errorMessage).toBeNull()
    expect(summary.isThirdPartyUsage).toBe(false)
    expect(buildValidationExcerpt(summary)).toBe("OK")
  })
})
