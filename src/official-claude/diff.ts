import { URL } from "node:url"
import type { CapturedRequestFixture } from "../proxy/capture"
import { readCapturedRequestFixture } from "../proxy/capture"
import { SYSTEM_IDENTITY } from "../proxy/transforms"
import type { OfficialClaudeRedactedCapture } from "./capture"
import { readOfficialClaudeRedactedCapture } from "./capture"

const BILLING_PREFIX = "x-anthropic-billing-header"

interface NormalizedHeaders {
  userAgent: string | null
  xApp: string | null
  anthropicVersion: string | null
  anthropicBeta: string[]
}

interface NormalizedBody {
  model: string | null
  stream: boolean | null
  thinking: unknown
  outputConfig: unknown
  toolChoice: unknown
  systemEntries: Array<{
    type: string | null
    textKind: "billing" | "identity" | "other" | "none"
    cacheControlType: string | null
  }>
  messageRoles: string[]
  messageBlockTypes: string[][]
  toolNames: string[]
  toolSchemas: Array<{ name: string | null; schema: unknown }>
}

interface NormalizedCapture {
  method: string
  path: string
  headers: NormalizedHeaders
  body: NormalizedBody
}

function getHeader(headers: Record<string, string>, name: string): string | null {
  const lowerName = name.toLowerCase()
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName)
  return match?.[1] ?? null
}

function normalizeHeaders(headers: Record<string, string>): NormalizedHeaders {
  const anthropicBeta = (getHeader(headers, "anthropic-beta") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .sort()

  return {
    userAgent: getHeader(headers, "user-agent"),
    xApp: getHeader(headers, "x-app"),
    anthropicVersion: getHeader(headers, "anthropic-version"),
    anthropicBeta
  }
}

function normalizeTextKind(text: string | undefined): "billing" | "identity" | "other" | "none" {
  if (!text) return "none"
  if (text.startsWith(BILLING_PREFIX)) return "billing"
  if (text === SYSTEM_IDENTITY) return "identity"
  return "other"
}

function normalizeSystemEntries(system: unknown): NormalizedBody["systemEntries"] {
  if (typeof system === "string") {
    return [{
      type: "text",
      textKind: normalizeTextKind(system),
      cacheControlType: null
    }]
  }

  if (!Array.isArray(system)) return []

  return system.map((entry) => {
    if (typeof entry === "string") {
      return {
        type: "text",
        textKind: normalizeTextKind(entry),
        cacheControlType: null
      }
    }

    const typedEntry = (entry ?? {}) as Record<string, unknown>
    const cacheControl = typedEntry.cache_control as Record<string, unknown> | undefined
    return {
      type: typeof typedEntry.type === "string" ? typedEntry.type : null,
      textKind: normalizeTextKind(typeof typedEntry.text === "string" ? typedEntry.text : undefined),
      cacheControlType: typeof cacheControl?.type === "string" ? cacheControl.type : null
    }
  })
}

function normalizeMessageBlockTypes(messages: unknown): string[][] {
  if (!Array.isArray(messages)) return []

  return messages.map((message) => {
    const typedMessage = (message ?? {}) as Record<string, unknown>
    const content = typedMessage.content

    if (typeof content === "string") return ["text"]
    if (!Array.isArray(content)) return []

    return content.map((block) => {
      if (!block || typeof block !== "object") return "unknown"
      return typeof (block as Record<string, unknown>).type === "string"
        ? String((block as Record<string, unknown>).type)
        : "unknown"
    })
  })
}

function normalizeMessageRoles(messages: unknown): string[] {
  if (!Array.isArray(messages)) return []

  return messages.map((message) => {
    const typedMessage = (message ?? {}) as Record<string, unknown>
    return typeof typedMessage.role === "string" ? typedMessage.role : "unknown"
  })
}

function normalizeToolSchema(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeToolSchema(item))
  }

  const typedValue = value as Record<string, unknown>
  const normalized: Record<string, unknown> = {}

  for (const key of Object.keys(typedValue).sort()) {
    if (key === "description") continue
    normalized[key] = normalizeToolSchema(typedValue[key])
  }

  return normalized
}

function normalizeTools(tools: unknown): Pick<NormalizedBody, "toolNames" | "toolSchemas"> {
  if (!Array.isArray(tools)) {
    return {
      toolNames: [],
      toolSchemas: []
    }
  }

  return {
    toolNames: tools.map((tool) => {
      const typedTool = (tool ?? {}) as Record<string, unknown>
      return typeof typedTool.name === "string" ? typedTool.name : "unknown"
    }),
    toolSchemas: tools.map((tool) => {
      const typedTool = (tool ?? {}) as Record<string, unknown>
      return {
        name: typeof typedTool.name === "string" ? typedTool.name : null,
        schema: normalizeToolSchema(typedTool.input_schema ?? null)
      }
    })
  }
}

function normalizeBody(body: unknown): NormalizedBody {
  const typedBody = (body ?? {}) as Record<string, unknown>
  const tools = normalizeTools(typedBody.tools)

  return {
    model: typeof typedBody.model === "string" ? typedBody.model : null,
    stream: typeof typedBody.stream === "boolean" ? typedBody.stream : null,
    thinking: normalizeToolSchema(typedBody.thinking ?? null),
    outputConfig: normalizeToolSchema(typedBody.output_config ?? null),
    toolChoice: normalizeToolSchema(typedBody.tool_choice ?? null),
    systemEntries: normalizeSystemEntries(typedBody.system),
    messageRoles: normalizeMessageRoles(typedBody.messages),
    messageBlockTypes: normalizeMessageBlockTypes(typedBody.messages),
    toolNames: tools.toolNames,
    toolSchemas: tools.toolSchemas
  }
}

function normalizeOfficialCapture(
  capture: OfficialClaudeRedactedCapture
): NormalizedCapture {
  const url = new URL(capture.request.url)
  return {
    method: capture.request.method,
    path: url.pathname,
    headers: normalizeHeaders(capture.request.headers),
    body: normalizeBody(capture.request.body)
  }
}

function normalizeProxyCapture(
  capture: CapturedRequestFixture
): NormalizedCapture {
  return {
    method: "POST",
    path: "/v1/messages",
    headers: normalizeHeaders(capture.proxy.outboundRequest.headers),
    body: normalizeBody(capture.proxy.outboundRequest.body)
  }
}

function diffValues(path: string, left: unknown, right: unknown, diffs: string[]): void {
  const leftIsArray = Array.isArray(left)
  const rightIsArray = Array.isArray(right)

  if (leftIsArray || rightIsArray) {
    if (!leftIsArray || !rightIsArray) {
      diffs.push(`${path}: type mismatch`)
      return
    }

    const leftArray = left as unknown[]
    const rightArray = right as unknown[]
    if (leftArray.length !== rightArray.length) {
      diffs.push(`${path}: length ${leftArray.length} != ${rightArray.length}`)
      return
    }

    leftArray.forEach((value, index) => {
      diffValues(`${path}[${index}]`, value, rightArray[index], diffs)
    })
    return
  }

  const leftIsObject = typeof left === "object" && left !== null
  const rightIsObject = typeof right === "object" && right !== null
  if (leftIsObject || rightIsObject) {
    if (!leftIsObject || !rightIsObject) {
      diffs.push(`${path}: type mismatch`)
      return
    }

    const leftObject = left as Record<string, unknown>
    const rightObject = right as Record<string, unknown>
    const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort()

    for (const key of keys) {
      diffValues(`${path}.${key}`, leftObject[key], rightObject[key], diffs)
    }
    return
  }

  if (left !== right) {
    diffs.push(`${path}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`)
  }
}

export function diffOfficialClaudeAgainstProxy(
  official: OfficialClaudeRedactedCapture,
  proxy: CapturedRequestFixture
): string[] {
  const diffs: string[] = []
  diffValues("request", normalizeOfficialCapture(official), normalizeProxyCapture(proxy), diffs)
  return diffs
}

export async function loadAndDiffOfficialClaudeAgainstProxy(
  officialPath: string,
  proxyPath: string
): Promise<string[]> {
  const official = await readOfficialClaudeRedactedCapture(officialPath)
  const proxy = await readCapturedRequestFixture(proxyPath)
  return diffOfficialClaudeAgainstProxy(official, proxy)
}
