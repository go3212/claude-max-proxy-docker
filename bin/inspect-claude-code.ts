#!/usr/bin/env bun

import {
  inspectInstalledClaudeCode,
  isInstalledClaudeRequired,
  resolveClaudeCodeMetadata
} from "../src/proxy/version"

const strictRequired = isInstalledClaudeRequired()
const installed = inspectInstalledClaudeCode()

console.log(`strict_required: ${strictRequired ? "yes" : "no"}`)
console.log(`claude_binary_path: ${installed.binaryPath ?? "not found"}`)
console.log(`claude_cli_version: ${installed.cliVersion ?? "not found"}`)
console.log(`claude_package_path: ${installed.packagePath ?? "not found"}`)
console.log(`claude_package_version: ${installed.packageVersion ?? "not found"}`)

try {
  const metadata = resolveClaudeCodeMetadata()
  console.log(`resolved_version: ${metadata.version}`)
  console.log(`resolved_source: ${metadata.source}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
