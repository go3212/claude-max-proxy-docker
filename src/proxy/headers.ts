import crypto from "node:crypto"
import { getModelBetas } from "./betas"

const sessionId = crypto.randomUUID()
type HeaderSource = Headers | Record<string, string> | Array<[string, string]>

function mergeHeaders(target: Headers, source?: HeaderSource): void {
  if (!source) return

  const headers = new Headers(source)
  headers.forEach((value, key) => {
    target.set(key, value)
  })
}

export function getUserAgent(cliVersion: string): string {
  return (
    process.env.ANTHROPIC_USER_AGENT ??
    `claude-cli/${cliVersion} (external, cli)`
  )
}

export function buildRequestHeaders(
  incomingHeaders: HeaderSource | undefined,
  accessToken: string,
  modelId: string,
  cliVersion: string
): Headers {
  const headers = new Headers()
  mergeHeaders(headers, incomingHeaders)

  const incomingBetas = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

  const mergedBetas = [...new Set([...getModelBetas(modelId), ...incomingBetas])]

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", mergedBetas.join(","))
  headers.set("x-app", "cli")
  headers.set("user-agent", getUserAgent(cliVersion))
  headers.set("x-client-request-id", crypto.randomUUID())
  headers.set("x-claude-code-session-id", sessionId)
  headers.delete("x-api-key")
  headers.delete("host")
  headers.delete("content-length")

  return headers
}

export function getClaudeCodeSessionId(): string {
  return sessionId
}
