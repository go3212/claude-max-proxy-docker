#!/usr/bin/env bun

import { runCapturedRequestValidation } from "../src/proxy/replay"

const fixturePath =
  process.argv[2] ??
  process.env.CLAUDE_PROXY_CAPTURE_PATH

if (!fixturePath) {
  console.error("Missing capture fixture path. Pass one as the first argument or set CLAUDE_PROXY_CAPTURE_PATH.")
  process.exit(1)
}

try {
  const result = await runCapturedRequestValidation(fixturePath)

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
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
