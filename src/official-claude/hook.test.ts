import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const {
  headersToObject,
  shouldCaptureUrl
} = require("../../bin/official-claude-hook.cjs") as {
  headersToObject: (headers: unknown) => Record<string, string>
  shouldCaptureUrl: (url: string) => boolean
}

describe("official claude hook", () => {
  test("captures only Anthropic messages requests", () => {
    expect(shouldCaptureUrl("https://api.anthropic.com/v1/messages")).toBe(true)
    expect(shouldCaptureUrl("https://api.anthropic.com/v1/models")).toBe(false)
    expect(shouldCaptureUrl("https://claude.ai/api/organizations")).toBe(false)
  })

  test("normalizes outgoing headers into a lowercase object", () => {
    expect(headersToObject({
      Authorization: "Bearer secret",
      "User-Agent": "claude-cli/2.1.104 (external, cli)"
    })).toEqual({
      authorization: "Bearer secret",
      "user-agent": "claude-cli/2.1.104 (external, cli)"
    })
  })
})
