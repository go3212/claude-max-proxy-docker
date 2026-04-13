const DEBUG_ENV_KEYS = [
  "CLAUDE_PROXY_DEBUG",
  "OPENCODE_CLAUDE_PROVIDER_DEBUG"
] as const

function isEnabled(value: string | undefined): boolean {
  if (!value) return false

  const normalized = value.trim().toLowerCase()
  return normalized !== "" && normalized !== "0" && normalized !== "false"
}

export function isDebugLoggingEnabled(): boolean {
  return DEBUG_ENV_KEYS.some((key) => isEnabled(process.env[key]))
}

export const claudeLog = (message: string, extra?: Record<string, unknown>) => {
  if (!isDebugLoggingEnabled()) return

  const parts = ["[claude-max-proxy]", message]
  if (extra && Object.keys(extra).length > 0) {
    parts.push(JSON.stringify(extra))
  }

  console.debug(parts.join(" "))
}
