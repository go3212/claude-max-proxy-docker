import { getModelOverride } from "./model-config"
import { buildBillingHeaderValue } from "./signing"

const BILLING_PREFIX = "x-anthropic-billing-header"

export const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

export interface SystemEntry {
  type?: string
  text?: string
  cache_control?: unknown
  [key: string]: unknown
}

export interface ContentBlock {
  type?: string
  text?: string
  [key: string]: unknown
}

export interface AnthropicMessage {
  role?: string
  content?: string | ContentBlock[]
}

export interface AnthropicRequestBody extends Record<string, unknown> {
  model?: string
  system?: string | Array<SystemEntry | string>
  thinking?: Record<string, unknown>
  output_config?: Record<string, unknown>
  messages?: AnthropicMessage[]
  temperature?: number
  stream?: boolean
}

export interface TransformOptions {
  version: string
  entrypoint: string
}

export interface TransformResult {
  body: string
  modelId: string
  stream: boolean
  transformed: boolean
}

function entryText(entry: SystemEntry | string): string {
  if (typeof entry === "string") return entry
  return typeof entry.text === "string" ? entry.text : ""
}

function normalizeSystemEntries(
  system: AnthropicRequestBody["system"]
): Array<SystemEntry | string> {
  if (typeof system === "string") {
    return system ? [{ type: "text", text: system }] : []
  }

  if (Array.isArray(system)) {
    return [...system]
  }

  return []
}

function hasIdentityEntry(entries: Array<SystemEntry | string>): boolean {
  return entries.some((entry) => entryText(entry).startsWith(SYSTEM_IDENTITY))
}

function supportsAdaptiveThinking(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return lower.includes("4-6") || lower.includes("4.6")
}

function stripAdaptiveTemperature(body: AnthropicRequestBody): void {
  const modelId = typeof body.model === "string" ? body.model : ""
  if (!supportsAdaptiveThinking(modelId)) return
  if (body.temperature === undefined) return
  if (body.temperature === 1 || body.temperature === 1.0) return
  delete body.temperature
}

export function applyClaudeCodeRequestTransforms(
  parsed: AnthropicRequestBody,
  options: TransformOptions
): AnthropicRequestBody {
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  const normalizedSystem = normalizeSystemEntries(parsed.system)
    .filter((entry) => !entryText(entry).startsWith(BILLING_PREFIX))

  if (!hasIdentityEntry(normalizedSystem)) {
    normalizedSystem.unshift({ type: "text", text: SYSTEM_IDENTITY })
  }

  const billingHeader = buildBillingHeaderValue(messages, options.version, options.entrypoint)
  normalizedSystem.unshift({ type: "text", text: billingHeader })

  const splitSystem: Array<SystemEntry | string> = []
  for (const entry of normalizedSystem) {
    if (
      typeof entry !== "string" &&
      entry.type === "text" &&
      typeof entry.text === "string" &&
      entry.text.startsWith(SYSTEM_IDENTITY) &&
      entry.text.length > SYSTEM_IDENTITY.length
    ) {
      const rest = entry.text.slice(SYSTEM_IDENTITY.length).replace(/^\n+/, "")
      const { text: _text, ...entryProps } = entry
      const { cache_control: _cacheControl, ...identityProps } = entryProps
      splitSystem.push({ ...identityProps, text: SYSTEM_IDENTITY })
      if (rest.length > 0) {
        splitSystem.push({ ...entryProps, text: rest })
      }
      continue
    }

    splitSystem.push(entry)
  }

  parsed.system = splitSystem

  const keptSystem: Array<SystemEntry | string> = []
  const movedTexts: string[] = []
  for (const entry of splitSystem) {
    const text = entryText(entry)
    if (text.startsWith(BILLING_PREFIX) || text.startsWith(SYSTEM_IDENTITY)) {
      keptSystem.push(entry)
    } else if (text.length > 0) {
      movedTexts.push(text)
    }
  }

  if (movedTexts.length > 0 && Array.isArray(parsed.messages)) {
    const firstUser = parsed.messages.find((message) => message.role === "user")
    if (firstUser) {
      parsed.system = keptSystem
      const prefix = movedTexts.join("\n\n")

      if (typeof firstUser.content === "string") {
        firstUser.content = `${prefix}\n\n${firstUser.content}`
      } else if (Array.isArray(firstUser.content)) {
        firstUser.content.unshift({ type: "text", text: prefix })
      } else {
        firstUser.content = prefix
      }
    }
  }

  const modelId = parsed.model ?? ""
  const override = getModelOverride(modelId)
  if (override?.disableEffort) {
    if (parsed.output_config) {
      delete parsed.output_config.effort
      if (Object.keys(parsed.output_config).length === 0) {
        delete parsed.output_config
      }
    }

    if (parsed.thinking && "effort" in parsed.thinking) {
      delete parsed.thinking.effort
      if (Object.keys(parsed.thinking).length === 0) {
        delete parsed.thinking
      }
    }
  }

  stripAdaptiveTemperature(parsed)
  return parsed
}

export function transformBodyString(
  rawBody: string,
  options: TransformOptions
): TransformResult {
  try {
    const parsed = JSON.parse(rawBody) as AnthropicRequestBody
    const transformed = applyClaudeCodeRequestTransforms(parsed, options)
    return {
      body: JSON.stringify(transformed),
      modelId: transformed.model ?? "unknown",
      stream: transformed.stream === true,
      transformed: true
    }
  } catch {
    return {
      body: rawBody,
      modelId: "unknown",
      stream: rawBody.includes('"stream":true') || rawBody.includes('"stream": true'),
      transformed: false
    }
  }
}
