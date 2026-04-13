#!/usr/bin/env bun

import { runProxyValidationRequest } from "../src/proxy/replay"

const model =
  process.env.CLAUDE_PROXY_VALIDATE_MODEL ??
  "claude-sonnet-4-5-20250929"
const systemPrompt =
  process.env.CLAUDE_PROXY_VALIDATE_SYSTEM ??
  "Follow the user request exactly. Reply with exactly OK."
const userPrompt =
  process.env.CLAUDE_PROXY_VALIDATE_PROMPT ??
  "Reply with exactly OK."

const requestBody = {
  model,
  max_tokens: 16,
  stream: false,
  system: systemPrompt,
  messages: [
    {
      role: "user",
      content: userPrompt
    }
  ]
}

const result = await runProxyValidationRequest({
  method: "POST",
  path: "/v1/messages",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify(requestBody),
  model
})

console.log(`status: ${result.status}`)
console.log(`model: ${result.model}`)
console.log(`claude_code_version: ${result.claudeCodeVersion}`)
console.log(`third_party_usage_detected: ${result.summary.isThirdPartyUsage ? "yes" : "no"}`)

if (result.excerpt) {
  console.log(`response_excerpt: ${result.excerpt}`)
}

if (!result.accepted) {
  process.exitCode = 1
}
