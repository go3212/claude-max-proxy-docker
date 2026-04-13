import { execFileSync } from "node:child_process"
import { config } from "./model-config"

const VERSION_PATTERN = /(\d+\.\d+\.\d+)/

let cachedVersion: string | null = null

export function resolveClaudeCodeVersion(): string {
  if (cachedVersion) return cachedVersion

  const envVersion =
    process.env.CLAUDE_PROXY_CLAUDE_CODE_VERSION ??
    process.env.ANTHROPIC_CLI_VERSION
  if (envVersion?.trim()) {
    cachedVersion = envVersion.trim()
    return cachedVersion
  }

  try {
    const rawVersion = execFileSync("claude", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    })
    const match = rawVersion.match(VERSION_PATTERN)
    if (match?.[1]) {
      cachedVersion = match[1]
      return cachedVersion
    }
  } catch {
    // Fall back to the pinned default below.
  }

  cachedVersion = config.ccVersion
  return cachedVersion
}

export function resetResolvedClaudeCodeVersion(): void {
  cachedVersion = null
}
