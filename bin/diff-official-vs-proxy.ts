#!/usr/bin/env bun

import { getOfficialClaudeCapturePaths } from "../src/official-claude/capture"
import { loadAndDiffOfficialClaudeAgainstProxy } from "../src/official-claude/diff"

const defaultOfficialPaths = getOfficialClaudeCapturePaths()
const officialPath = process.argv[2] ?? defaultOfficialPaths.redactedPath
const proxyPath =
  process.argv[3] ??
  process.env.CLAUDE_PROXY_CAPTURE_PATH ??
  "./captures/latest-request.json"

try {
  const diffs = await loadAndDiffOfficialClaudeAgainstProxy(officialPath, proxyPath)

  console.log(`official_capture: ${officialPath}`)
  console.log(`proxy_capture: ${proxyPath}`)

  if (diffs.length === 0) {
    console.log("diff_status: no_meaningful_difference")
    process.exit(0)
  }

  console.log(`diff_status: mismatch`)
  for (const diff of diffs) {
    console.log(`diff: ${diff}`)
  }
  process.exit(1)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
