import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { ClaudeProxySystemMode } from "./system-mode"
import type { TransformSummary } from "./transforms"
import type { ToolBridgeResult } from "./tool-bridge"

const CAPTURE_SCHEMA_VERSION = 1
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-session-affinity",
  "x-api-key"
])
const SENSITIVE_KEY_FRAGMENTS = [
  "token",
  "secret",
  "authorization",
  "cookie",
  "password",
  "signature"
]
const REDACTED_IMAGE_DATA = "[redacted-image-data]"

type PlaceholderKind =
  | "assistant"
  | "description"
  | "generic"
  | "header"
  | "image"
  | "sensitive"
  | "system"
  | "thinking"
  | "tool"
  | "user"

interface RedactionState {
  counters: Record<PlaceholderKind, number>
}

export interface CapturedRequestFixture {
  schemaVersion: number
  capturedAt: string
  request: {
    method: string
    path: string
    headers: Record<string, string>
    body: unknown
  }
  proxy: {
    claudeCodeVersion: string
    entrypoint: string
    systemMode: ClaudeProxySystemMode
    modelId: string
    stream: boolean
    transformed: boolean
    betas: string[]
    mappedTools: ToolBridgeResult["mappedToolNames"]
    unsupportedToolNames: string[]
    summary: TransformSummary
    outboundRequest: {
      headers: Record<string, string>
      body: unknown
      droppedIncomingHeaders: string[]
      droppedIncomingBetas: string[]
    }
  }
}

export interface BuildCaptureFixtureOptions {
  method: string
  path: string
  headers: Headers
  rawBody: string
  claudeCodeVersion: string
  entrypoint: string
  systemMode: ClaudeProxySystemMode
  modelId: string
  stream: boolean
  transformed: boolean
  betas: string[]
  mappedTools: ToolBridgeResult["mappedToolNames"]
  unsupportedToolNames: string[]
  summary: TransformSummary
  outgoingHeaders: Headers
  outgoingBody: string
  droppedIncomingHeaders: string[]
  droppedIncomingBetas: string[]
}

function createRedactionState(): RedactionState {
  return {
    counters: {
      assistant: 0,
      description: 0,
      generic: 0,
      header: 0,
      image: 0,
      sensitive: 0,
      system: 0,
      thinking: 0,
      tool: 0,
      user: 0
    }
  }
}

function nextPlaceholder(state: RedactionState, kind: PlaceholderKind): string {
  state.counters[kind] += 1
  return `[redacted-${kind}-${state.counters[kind]}]`
}

function sanitizeHeaders(headers: Headers): Record<string, string> {
  const state = createRedactionState()
  const sanitized: Record<string, string> = {}

  for (const [key, value] of headers) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) {
      sanitized[key] = nextPlaceholder(state, "header")
      continue
    }

    sanitized[key] = value
  }

  return sanitized
}

function sanitizeString(
  value: string,
  state: RedactionState,
  kind: PlaceholderKind
): string {
  if (!value) return value
  return nextPlaceholder(state, kind)
}

function sanitizeByKey(
  key: string,
  value: unknown,
  state: RedactionState,
  fallbackKind: PlaceholderKind
): unknown {
  const lower = key.toLowerCase()

  if (
    lower === "model" ||
    lower === "role" ||
    lower === "type" ||
    lower === "name" ||
    lower === "id" ||
    lower === "default" ||
    lower === "effort" ||
    lower === "format" ||
    lower === "media_type" ||
    lower === "mime_type" ||
    lower === "pattern" ||
    lower === "ref" ||
    lower === "$ref" ||
    lower === "$schema"
  ) {
    return value
  }

  if (lower === "required" || lower === "enum") {
    return value
  }

  if (SENSITIVE_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
    if (typeof value === "string") {
      return nextPlaceholder(state, "sensitive")
    }

    return sanitizeValue(value, state, "sensitive")
  }

  if (lower === "text") {
    return typeof value === "string"
      ? sanitizeString(value, state, fallbackKind)
      : sanitizeValue(value, state, fallbackKind)
  }

  if (lower === "description") {
    return typeof value === "string"
      ? sanitizeString(value, state, "description")
      : sanitizeValue(value, state, "description")
  }

  if (lower === "thinking") {
    return sanitizeValue(value, state, "thinking")
  }

  if (lower === "input") {
    return sanitizeValue(value, state, "tool")
  }

  if (lower === "data" || lower === "url") {
    if (typeof value === "string") {
      return lower === "data"
        ? REDACTED_IMAGE_DATA
        : nextPlaceholder(state, "image")
    }

    return sanitizeValue(value, state, "image")
  }

  return sanitizeValue(value, state, fallbackKind)
}

function sanitizeContentBlock(
  block: unknown,
  state: RedactionState,
  roleKind: PlaceholderKind
): unknown {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return sanitizeValue(block, state, roleKind)
  }

  const typedBlock = block as Record<string, unknown>
  const blockType = typeof typedBlock.type === "string" ? typedBlock.type : ""
  const sanitized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(typedBlock)) {
    if (blockType === "tool_use" && (key === "name" || key === "id" || key === "type")) {
      sanitized[key] = value
      continue
    }

    sanitized[key] = sanitizeByKey(key, value, state, roleKind)
  }

  return sanitized
}

function sanitizeMessage(message: unknown, state: RedactionState): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return sanitizeValue(message, state, "generic")
  }

  const typedMessage = message as Record<string, unknown>
  const roleKind: PlaceholderKind =
    typedMessage.role === "assistant" ? "assistant" : "user"
  const sanitized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(typedMessage)) {
    if (key === "content") {
      if (typeof value === "string") {
        sanitized[key] = sanitizeString(value, state, roleKind)
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map((block) =>
          sanitizeContentBlock(block, state, roleKind)
        )
      } else {
        sanitized[key] = sanitizeValue(value, state, roleKind)
      }
      continue
    }

    sanitized[key] = sanitizeByKey(key, value, state, roleKind)
  }

  return sanitized
}

function sanitizeSystemEntry(entry: unknown, state: RedactionState): unknown {
  if (typeof entry === "string") {
    return sanitizeString(entry, state, "system")
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return sanitizeValue(entry, state, "system")
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    sanitized[key] = sanitizeByKey(key, value, state, "system")
  }

  return sanitized
}

function sanitizeObject(
  value: Record<string, unknown>,
  state: RedactionState,
  fallbackKind: PlaceholderKind
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}

  for (const [key, entryValue] of Object.entries(value)) {
    if (key === "messages" && Array.isArray(entryValue)) {
      sanitized[key] = entryValue.map((message) => sanitizeMessage(message, state))
      continue
    }

    if (key === "system") {
      if (typeof entryValue === "string") {
        sanitized[key] = sanitizeString(entryValue, state, "system")
      } else if (Array.isArray(entryValue)) {
        sanitized[key] = entryValue.map((entry) => sanitizeSystemEntry(entry, state))
      } else {
        sanitized[key] = sanitizeValue(entryValue, state, "system")
      }
      continue
    }

    sanitized[key] = sanitizeByKey(key, entryValue, state, fallbackKind)
  }

  return sanitized
}

function sanitizeValue(
  value: unknown,
  state: RedactionState,
  fallbackKind: PlaceholderKind
): unknown {
  if (value === null || value === undefined) return value

  if (typeof value === "number" || typeof value === "boolean") {
    return value
  }

  if (typeof value === "string") {
    return sanitizeString(value, state, fallbackKind)
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, state, fallbackKind))
  }

  return sanitizeObject(value as Record<string, unknown>, state, fallbackKind)
}

export function sanitizeIncomingRequestBody(rawBody: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return {
      raw: "[redacted-non-json-body]"
    }
  }

  return sanitizeValue(parsed, createRedactionState(), "generic")
}

export function buildCapturedRequestFixture(
  options: BuildCaptureFixtureOptions
): CapturedRequestFixture {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    request: {
      method: options.method,
      path: options.path,
      headers: sanitizeHeaders(options.headers),
      body: sanitizeIncomingRequestBody(options.rawBody)
    },
    proxy: {
      claudeCodeVersion: options.claudeCodeVersion,
      entrypoint: options.entrypoint,
      systemMode: options.systemMode,
      modelId: options.modelId,
      stream: options.stream,
      transformed: options.transformed,
      betas: [...options.betas],
      mappedTools: options.mappedTools.map((item) => ({ ...item })),
      unsupportedToolNames: [...options.unsupportedToolNames],
      summary: { ...options.summary },
      outboundRequest: {
        headers: sanitizeHeaders(options.outgoingHeaders),
        body: sanitizeIncomingRequestBody(options.outgoingBody),
        droppedIncomingHeaders: [...options.droppedIncomingHeaders],
        droppedIncomingBetas: [...options.droppedIncomingBetas]
      }
    }
  }
}

export async function writeCapturedRequestFixture(
  path: string,
  fixture: CapturedRequestFixture
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(fixture, null, 2), "utf-8")
}

export async function readCapturedRequestFixture(
  path: string
): Promise<CapturedRequestFixture> {
  let raw: string
  try {
    raw = await readFile(path, "utf-8")
  } catch (error) {
    throw new Error(
      `Failed to read capture fixture at ${path}.\n` +
      (error instanceof Error ? error.message : String(error))
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Failed to parse capture fixture at ${path}.\n` +
      (error instanceof Error ? error.message : String(error))
    )
  }

  const fixture = parsed as Partial<CapturedRequestFixture>
  if (
    typeof fixture !== "object" ||
    fixture === null ||
    typeof fixture.request?.path !== "string" ||
    typeof fixture.request?.method !== "string" ||
    typeof fixture.request?.headers !== "object" ||
    fixture.request.headers === null ||
    fixture.request.body === undefined
  ) {
    throw new Error(`Capture fixture at ${path} is missing the request payload.`)
  }

  if (
    typeof fixture.proxy?.claudeCodeVersion !== "string" ||
    typeof fixture.proxy?.modelId !== "string"
  ) {
    throw new Error(`Capture fixture at ${path} is missing proxy metadata.`)
  }

  return fixture as CapturedRequestFixture
}
