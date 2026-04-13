import { getModelOverride } from "./model-config"
import { buildBillingHeaderValue } from "./signing"
import {
  cloneOfficialClaudeBodyTemplate,
  type OfficialClaudeScaffold
} from "./official-scaffold"
import {
  applyRequestToolBridge,
  type ToolBridgeResult,
  type UnsupportedToolMode
} from "./tool-bridge"
import type { ClaudeProxySystemMode } from "./system-mode"

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
  tools?: unknown[]
  tool_choice?: Record<string, unknown>
  context_management?: Record<string, unknown>
  metadata?: Record<string, unknown>
  max_tokens?: number
  temperature?: number
  stream?: boolean
}

export interface TransformOptions {
  version: string
  entrypoint: string
  scaffold: OfficialClaudeScaffold
  systemMode?: ClaudeProxySystemMode
  unsupportedToolMode?: UnsupportedToolMode
  metadataUserId?: string | null
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
  toolBridge: ToolBridgeResult
}

const EMPTY_SUMMARY: TransformSummary = {
  movedSystemTextCount: 0,
  hadFirstUserMessage: false,
  hadFirstUserTextBlock: false,
  finalSystemTextCount: 0,
  textSystemReducedToCoreOnly: false
}

const EMPTY_TOOL_BRIDGE: ToolBridgeResult = {
  mappedToolNames: [],
  officialToOpenNames: {},
  unsupportedToolNames: [],
  hasTools: false
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeSystemEntries(
  system: AnthropicRequestBody["system"]
): Array<SystemEntry | string> {
  if (typeof system === "string") {
    return system ? [{ type: "text", text: system }] : []
  }

  if (Array.isArray(system)) {
    return cloneValue(system)
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
  const finalSystemTextCount = textEntries.length

  return {
    movedSystemTextCount,
    hadFirstUserMessage: firstUserSummary.hadFirstUserMessage,
    hadFirstUserTextBlock: firstUserSummary.hadFirstUserTextBlock,
    finalSystemTextCount,
    textSystemReducedToCoreOnly: textEntries.every((entry) => {
      const text = typeof entry === "string" ? entry : entry.text ?? ""
      return text.startsWith(BILLING_PREFIX) || text === SYSTEM_IDENTITY
    })
  }
}

function extractIncomingSystem(
  system: AnthropicRequestBody["system"],
  scaffold: OfficialClaudeScaffold,
  systemMode: ClaudeProxySystemMode
): {
  movedTexts: string[]
  preservedEntries: Array<SystemEntry | string>
} {
  const movedTexts: string[] = []
  const preservedEntries: Array<SystemEntry | string> = []
  const scaffoldTextEntries = new Set(
    systemMode === "official"
      ? normalizeSystemEntries(scaffold.bodyTemplate.system)
          .map((entry) => typeof entry === "string" ? entry : entry.text ?? "")
          .filter((text) => text && !text.startsWith(BILLING_PREFIX))
      : []
  )

  for (const entry of normalizeSystemEntries(system)) {
    if (typeof entry === "string") {
      if (entry.startsWith(SYSTEM_IDENTITY)) {
        const remainder = entry.slice(SYSTEM_IDENTITY.length).replace(/^\n+/, "")
        if (remainder && !scaffoldTextEntries.has(remainder)) {
          movedTexts.push(remainder)
        }
        continue
      }
      if (scaffoldTextEntries.has(entry)) {
        continue
      }
      if (entry && !entry.startsWith(BILLING_PREFIX)) {
        movedTexts.push(entry)
      }
      continue
    }

    if (entry.type !== "text") {
      preservedEntries.push(entry)
      continue
    }

    const text = entry.text ?? ""
    if (text.startsWith(SYSTEM_IDENTITY)) {
      const remainder = text.slice(SYSTEM_IDENTITY.length).replace(/^\n+/, "")
      if (remainder && !scaffoldTextEntries.has(remainder)) {
        movedTexts.push(remainder)
      }
      continue
    }
    if (text && scaffoldTextEntries.has(text)) {
      continue
    }
    if (text && !text.startsWith(BILLING_PREFIX)) {
      movedTexts.push(text)
    }
  }

  return {
    movedTexts,
    preservedEntries
  }
}

function buildHermesMinimalSystem(
  billingText: string,
  preservedIncomingEntries: Array<SystemEntry | string>
): Array<SystemEntry | string> {
  return [
    {
      type: "text",
      text: billingText
    },
    { type: "text", text: SYSTEM_IDENTITY },
    ...preservedIncomingEntries
  ]
}

function buildScaffoldSystem(
  scaffold: OfficialClaudeScaffold,
  billingText: string,
  preservedIncomingEntries: Array<SystemEntry | string>
): Array<SystemEntry | string> {
  const scaffoldSystem = normalizeSystemEntries(scaffold.bodyTemplate.system)
    .filter((entry) => {
      const text = typeof entry === "string" ? entry : entry.text ?? ""
      return !text.startsWith(BILLING_PREFIX)
    })

  return [
    {
      type: "text",
      text: billingText
    },
    ...scaffoldSystem,
    ...preservedIncomingEntries
  ]
}

function applyMetadata(
  outgoing: AnthropicRequestBody,
  scaffold: OfficialClaudeScaffold,
  metadataUserId: string | null | undefined
): void {
  if (!outgoing.metadata && scaffold.bodyTemplate.metadata) {
    outgoing.metadata = cloneValue(scaffold.bodyTemplate.metadata)
  }

  if (!outgoing.metadata || typeof outgoing.metadata !== "object") {
    if (!metadataUserId) return
    outgoing.metadata = {}
  }

  if (metadataUserId) {
    outgoing.metadata = {
      ...(outgoing.metadata as Record<string, unknown>),
      user_id: metadataUserId
    }
  }
}

export function applyClaudeCodeRequestTransforms(
  parsed: AnthropicRequestBody,
  options: TransformOptions
): AnthropicRequestBody & { __transformSummary__?: TransformSummary; __toolBridge__?: ToolBridgeResult } {
  const systemMode = options.systemMode ?? "official"
  const unsupportedToolMode = options.unsupportedToolMode ?? "keep"
  const outgoing = cloneOfficialClaudeBodyTemplate(options.scaffold)

  outgoing.model = parsed.model ?? outgoing.model
  outgoing.max_tokens = parsed.max_tokens ?? outgoing.max_tokens
  outgoing.stream = parsed.stream ?? outgoing.stream ?? false
  outgoing.thinking = parsed.thinking ? cloneValue(parsed.thinking) : outgoing.thinking
  outgoing.output_config = parsed.output_config ? cloneValue(parsed.output_config) : outgoing.output_config
  outgoing.tool_choice = parsed.tool_choice ? cloneValue(parsed.tool_choice) : outgoing.tool_choice
  outgoing.messages = Array.isArray(parsed.messages) ? cloneValue(parsed.messages) : []
  outgoing.tools = Array.isArray(parsed.tools) ? cloneValue(parsed.tools) : []

  if (outgoing.messages.length === 0) {
    stripAdaptiveTemperature(parsed)
    Object.assign(outgoing, parsed)
    ;(outgoing as AnthropicRequestBody & { __transformSummary__?: TransformSummary }).__transformSummary__ = EMPTY_SUMMARY
    ;(outgoing as AnthropicRequestBody & { __toolBridge__?: ToolBridgeResult }).__toolBridge__ = EMPTY_TOOL_BRIDGE
    return outgoing as AnthropicRequestBody & { __transformSummary__?: TransformSummary; __toolBridge__?: ToolBridgeResult }
  }

  const toolBridge = applyRequestToolBridge(
    outgoing as Record<string, unknown>,
    unsupportedToolMode
  )

  if (!toolBridge.hasTools) {
    delete outgoing.tools
    delete outgoing.tool_choice
  } else if (Array.isArray(parsed.tools)) {
    outgoing.tools = (outgoing.tools ?? []) as unknown[]
  }

  if (!outgoing.context_management && options.scaffold.bodyTemplate.context_management) {
    outgoing.context_management = cloneValue(options.scaffold.bodyTemplate.context_management)
  }

  applyMetadata(outgoing, options.scaffold, options.metadataUserId)

  const extractedSystem = extractIncomingSystem(parsed.system, options.scaffold, systemMode)
  const billingText = buildBillingHeaderValue(outgoing.messages ?? [], options.version, options.entrypoint)
  outgoing.system = systemMode === "hermes-minimal"
    ? buildHermesMinimalSystem(billingText, extractedSystem.preservedEntries)
    : buildScaffoldSystem(options.scaffold, billingText, extractedSystem.preservedEntries)
  const firstUserSummary = prependToFirstUserMessage(
    outgoing.messages ?? [],
    extractedSystem.movedTexts
  )

  const modelId = outgoing.model ?? ""
  const override = getModelOverride(modelId)
  if (override?.disableEffort) {
    if (outgoing.output_config) {
      delete outgoing.output_config.effort
      if (Object.keys(outgoing.output_config).length === 0) {
        delete outgoing.output_config
      }
    }

    if (outgoing.thinking && "effort" in outgoing.thinking) {
      delete outgoing.thinking.effort
      if (Object.keys(outgoing.thinking).length === 0) {
        delete outgoing.thinking
      }
    }
  }

  outgoing.temperature = parsed.temperature
  stripAdaptiveTemperature(outgoing)

  ;(outgoing as AnthropicRequestBody & { __transformSummary__?: TransformSummary }).__transformSummary__ =
    summarizeTransformedBody(outgoing, extractedSystem.movedTexts.length, firstUserSummary)
  ;(outgoing as AnthropicRequestBody & { __toolBridge__?: ToolBridgeResult }).__toolBridge__ =
    toolBridge
  return outgoing as AnthropicRequestBody & { __transformSummary__?: TransformSummary; __toolBridge__?: ToolBridgeResult }
}

export function transformBodyString(
  rawBody: string,
  options: TransformOptions
): TransformResult {
  try {
    const parsed = JSON.parse(rawBody) as AnthropicRequestBody
    const transformed = applyClaudeCodeRequestTransforms(parsed, options)
    const summary = transformed.__transformSummary__ ?? EMPTY_SUMMARY
    const toolBridge = transformed.__toolBridge__ ?? EMPTY_TOOL_BRIDGE
    delete transformed.__transformSummary__
    delete transformed.__toolBridge__

    return {
      body: JSON.stringify(transformed),
      modelId: transformed.model ?? "unknown",
      stream: transformed.stream === true,
      transformed: true,
      summary,
      toolBridge
    }
  } catch {
    return {
      body: rawBody,
      modelId: "unknown",
      stream: rawBody.includes('"stream":true') || rawBody.includes('"stream": true'),
      transformed: false,
      summary: EMPTY_SUMMARY,
      toolBridge: EMPTY_TOOL_BRIDGE
    }
  }
}
