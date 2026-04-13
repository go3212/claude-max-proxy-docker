export type ClaudeProxySystemMode = "official" | "hermes-minimal"

export function resolveClaudeProxySystemMode(
  env: NodeJS.ProcessEnv = process.env
): ClaudeProxySystemMode {
  return env.CLAUDE_PROXY_SYSTEM_MODE === "hermes-minimal"
    ? "hermes-minimal"
    : "official"
}
