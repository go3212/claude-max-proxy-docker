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

export interface TransformSummary {
  movedSystemTextCount: number
  hadFirstUserMessage: boolean
  hadFirstUserTextBlock: boolean
  finalSystemTextCount: number
  textSystemReducedToCoreOnly: boolean
}

export interface TransformResult {
  body: string
  modelId: string
  stream: boolean
  transformed: boolean
  summary: TransformSummary
}

const EMPTY_SUMMARY: TransformSummary = {
  movedSystemTextCount: 0,
  hadFirstUserMessage: false,
  hadFirstUserTextBlock: false,
  finalSystemTextCount: 0,
  textSystemReducedToCoreOnly: false
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

function buildSystemReminderText(texts: string[]): string {
  return texts
    .map((text) => `<system-reminder>\n${text}\n</system-reminder>`)
    .join("\n\n")
}

function prependToFirstUserMessage(
  messages: AnthropicMessage[],
  texts: string[]
): Pick<TransformSummary, "hadFirstUserMessage" | "hadFirstUserTextBlock"> {
  if (texts.length === 0) {
    return {
      hadFirstUserMessage: false,
      hadFirstUserTextBlock: false
    }
  }

  const combined = buildSystemReminderText(texts)

  for (const message of messages) {
    if (message.role !== "user") continue

    if (typeof message.content === "string") {
      message.content = [{
        type: "text",
        text: message.content ? `${combined}\n\n${message.content}` : combined
      }]
      return {
        hadFirstUserMessage: true,
        hadFirstUserTextBlock: true
      }
    }

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          block.text = block.text ? `${combined}\n\n${block.text}` : combined
          return {
            hadFirstUserMessage: true,
            hadFirstUserTextBlock: true
          }
        }
      }

      message.content.unshift({
        type: "text",
        text: combined
      })
      return {
        hadFirstUserMessage: true,
        hadFirstUserTextBlock: false
      }
    }

    message.content = [{
      type: "text",
      text: combined
    }]
    return {
      hadFirstUserMessage: true,
      hadFirstUserTextBlock: false
    }
  }

  return {
    hadFirstUserMessage: false,
    hadFirstUserTextBlock: false
  }
}

function summarizeTransformedBody(
  body: AnthropicRequestBody,
  movedSystemTextCount: number,
  firstUserSummary: Pick<TransformSummary, "hadFirstUserMessage" | "hadFirstUserTextBlock">
): TransformSummary {
  const systemEntries = normalizeSystemEntries(body.system)
  const textEntries = systemEntries.filter((entry) => {
    if (typeof entry === "string") return entry.length > 0
    return entry.type === "text" && typeof entry.text === "string" && entry.text.length > 0
  })

  return {
    movedSystemTextCount,
    hadFirstUserMessage: firstUserSummary.hadFirstUserMessage,
    hadFirstUserTextBlock: firstUserSummary.hadFirstUserTextBlock,
    finalSystemTextCount: textEntries.length,
    textSystemReducedToCoreOnly: textEntries.every((entry) => {
      const text = entryText(entry)
      return text.startsWith(BILLING_PREFIX) || text === SYSTEM_IDENTITY
    })
  }
}

export function applyClaudeCodeRequestTransforms(
  parsed: AnthropicRequestBody,
  options: TransformOptions
): AnthropicRequestBody {
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  if (messages.length === 0) {
    stripAdaptiveTemperature(parsed)
    return parsed
  }

  const rawSystem = normalizeSystemEntries(parsed.system)
  const billingEntry: SystemEntry = {
    type: "text",
    text: buildBillingHeaderValue(messages, options.version, options.entrypoint)
  }

  const keptSystem: Array<SystemEntry | string> = []
  const movedTexts: string[] = []
  let identitySeen = false

  for (const entry of rawSystem) {
    if (typeof entry === "string") {
      if (entry.startsWith(BILLING_PREFIX)) continue
      if (entry.startsWith(SYSTEM_IDENTITY)) {
        if (identitySeen) continue
        identitySeen = true
        keptSystem.push(SYSTEM_IDENTITY)
        const rest = entry.slice(SYSTEM_IDENTITY.length).replace(/^\n+/, "")
        if (rest) movedTexts.push(rest)
        continue
      }
      if (entry) movedTexts.push(entry)
      continue
    }

    if (entry.type !== "text") {
      keptSystem.push(entry)
      continue
    }

    const text = entry.text ?? ""
    if (text.startsWith(BILLING_PREFIX)) {
      continue
    }

    if (text.startsWith(SYSTEM_IDENTITY)) {
      if (identitySeen) continue
      identitySeen = true
      const identityEntry: SystemEntry = { ...entry, text: SYSTEM_IDENTITY }
      keptSystem.push(identityEntry)
      const rest = text.slice(SYSTEM_IDENTITY.length).replace(/^\n+/, "")
      if (rest) movedTexts.push(rest)
      continue
    }

    if (text) {
      movedTexts.push(text)
    }
  }

  if (!identitySeen) {
    keptSystem.unshift({ type: "text", text: SYSTEM_IDENTITY })
  }

  parsed.system = [billingEntry, ...keptSystem]
  const firstUserSummary = prependToFirstUserMessage(messages, movedTexts)

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
  ;(parsed as AnthropicRequestBody & { __transformSummary__?: TransformSummary }).__transformSummary__ =
    summarizeTransformedBody(parsed, movedTexts.length, firstUserSummary)
  return parsed
}

export function transformBodyString(
  rawBody: string,
  options: TransformOptions
): TransformResult {
  try {
    const parsed = JSON.parse(rawBody) as AnthropicRequestBody
    const transformed = applyClaudeCodeRequestTransforms(parsed, options) as AnthropicRequestBody & {
      __transformSummary__?: TransformSummary
    }
    const summary = transformed.__transformSummary__ ?? EMPTY_SUMMARY
    delete transformed.__transformSummary__

    return {
      body: JSON.stringify(transformed),
      modelId: transformed.model ?? "unknown",
      stream: transformed.stream === true,
      transformed: true,
      summary
    }
  } catch {
    return {
      body: rawBody,
      modelId: "unknown",
      stream: rawBody.includes('"stream":true') || rawBody.includes('"stream": true'),
      transformed: false,
      summary: EMPTY_SUMMARY
    }
  }
}
