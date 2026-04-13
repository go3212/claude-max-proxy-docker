import crypto from "node:crypto"
import { getModelBetas } from "./betas"

const sessionId = crypto.randomUUID()

type HeaderSource = Headers | Record<string, string> | Array<[string, string]>

const CONSUMED_INCOMING_HEADERS = new Set([
  "anthropic-beta",
  "content-type"
])

const SENSITIVE_OUTBOUND_HEADERS = new Set([
  "authorization"
])

export interface RequestHeaderBuildResult {
  headers: Headers
  betas: string[]
  droppedIncomingBetas: string[]
  droppedIncomingHeaders: string[]
  debugHeaders: Record<string, string>
}

function parseIncomingBetas(source?: HeaderSource): string[] {
  const headers = new Headers(source)
  return (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function summarizeDroppedIncomingHeaders(source?: HeaderSource): string[] {
  const headers = new Headers(source)
  const dropped = new Set<string>()

  for (const [key] of headers) {
    const lower = key.toLowerCase()
    if (CONSUMED_INCOMING_HEADERS.has(lower)) continue
    dropped.add(lower)
  }

  return [...dropped].sort()
}

function summarizeHeadersForDebug(headers: Headers): Record<string, string> {
  const summary: Record<string, string> = {}

  for (const [key, value] of headers) {
    summary[key] = SENSITIVE_OUTBOUND_HEADERS.has(key.toLowerCase())
      ? "[redacted]"
      : value
  }

  return summary
}

export function getUserAgent(cliVersion: string): string {
  return (
    process.env.ANTHROPIC_USER_AGENT ??
    `claude-cli/${cliVersion} (external, cli)`
  )
}

export function prepareRequestHeaders(
  incomingHeaders: HeaderSource | undefined,
  accessToken: string,
  modelId: string,
  cliVersion: string
): RequestHeaderBuildResult {
  const betas = getModelBetas(modelId)
  const incomingBetas = parseIncomingBetas(incomingHeaders)

  const headers = new Headers()
  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", betas.join(","))
  headers.set("x-app", "cli")
  headers.set("user-agent", getUserAgent(cliVersion))
  headers.set("x-client-request-id", crypto.randomUUID())
  headers.set("x-claude-code-session-id", sessionId)
  headers.set("content-type", "application/json")

  return {
    headers,
    betas,
    droppedIncomingBetas: incomingBetas
      .filter((beta) => !betas.includes(beta))
      .sort(),
    droppedIncomingHeaders: summarizeDroppedIncomingHeaders(incomingHeaders),
    debugHeaders: summarizeHeadersForDebug(headers)
  }
}

export function buildRequestHeaders(
  incomingHeaders: HeaderSource | undefined,
  accessToken: string,
  modelId: string,
  cliVersion: string
): Headers {
  return prepareRequestHeaders(
    incomingHeaders,
    accessToken,
    modelId,
    cliVersion
  ).headers
}

export function getClaudeCodeSessionId(): string {
  return sessionId
}
