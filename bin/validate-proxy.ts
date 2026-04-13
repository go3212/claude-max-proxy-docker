#!/usr/bin/env bun

import { createProxyServer } from "../src/proxy/server"
import {
  buildValidationExcerpt,
  summarizeAnthropicResponse
} from "../src/proxy/validation"

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

const { app, claudeCodeVersion } = createProxyServer()

const response = await app.request("http://localhost/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify(requestBody)
})

const rawBody = await response.text()
const summary = summarizeAnthropicResponse(rawBody)

console.log(`status: ${response.status}`)
console.log(`model: ${model}`)
console.log(`claude_code_version: ${claudeCodeVersion}`)
console.log(`third_party_usage_detected: ${summary.isThirdPartyUsage ? "yes" : "no"}`)

const excerpt = buildValidationExcerpt(summary)
if (excerpt) {
  console.log(`response_excerpt: ${excerpt}`)
}

const accepted =
  response.ok &&
  !summary.isThirdPartyUsage &&
  !summary.errorMessage &&
  Boolean(summary.assistantText || rawBody.trim())

if (!accepted) {
  process.exitCode = 1
}
