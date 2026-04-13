#!/usr/bin/env bun

import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  finalizeOfficialClaudeCapture,
  getOfficialClaudeCapturePaths
} from "../src/official-claude/capture"
import { inspectInstalledClaudeCode } from "../src/proxy/version"

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error("Missing Claude CLI arguments. Example: bun run capture:official-claude -- -p \"Hello\"")
  process.exit(1)
}

const hookPath = fileURLToPath(new URL("./official-claude-hook.cjs", import.meta.url))
const capturePaths = getOfficialClaudeCapturePaths()
const installed = inspectInstalledClaudeCode()
const binaryPath = installed.binaryPath ?? "claude"
const runId = crypto.randomUUID()

function mergeNodeOptions(existing: string | undefined, requiredFlag: string): string {
  if (!existing?.trim()) return requiredFlag
  return `${requiredFlag} ${existing.trim()}`
}

const child = spawn(binaryPath, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: mergeNodeOptions(process.env.NODE_OPTIONS, `--require ${hookPath}`),
    CLAUDE_OFFICIAL_CAPTURE_RAW_PATH: capturePaths.rawPath,
    CLAUDE_OFFICIAL_CAPTURE_REDACTED_PATH: capturePaths.redactedPath,
    CLAUDE_OFFICIAL_CAPTURE_BINARY_PATH: installed.binaryPath ?? "",
    CLAUDE_OFFICIAL_CAPTURE_RUN_ID: runId
  }
})

const childExitCode = await new Promise<number>((resolve) => {
  child.on("close", (code, signal) => {
    if (signal) {
      resolve(1)
      return
    }

    resolve(code ?? 0)
  })
})

let finalized = false
if (existsSync(capturePaths.rawPath)) {
  try {
    await finalizeOfficialClaudeCapture(
      capturePaths.rawPath,
      capturePaths.redactedPath,
      runId
    )
    finalized = true
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
  }
}

if (!finalized) {
  console.error(`No official Claude capture was produced at ${capturePaths.rawPath}.`)
  if (childExitCode === 0) {
    process.exit(1)
  }
  process.exit(childExitCode)
}

console.log(`official_raw_capture: ${capturePaths.rawPath}`)
console.log(`official_redacted_capture: ${capturePaths.redactedPath}`)
process.exit(childExitCode)
