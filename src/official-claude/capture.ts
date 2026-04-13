import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, posix } from "node:path"
import { sanitizeIncomingRequestBody } from "../proxy/capture"

const CAPTURE_SCHEMA_VERSION = 1
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-session-affinity"
])

export interface OfficialClaudeRawCapture {
  schemaVersion: number
  capturedAt: string
  runtime: {
    transport: string
    binaryPath?: string | null
    argv?: string[]
    runId?: string | null
  }
  request: {
    url: string
    method: string
    headers: Record<string, string>
    body: string | null
  }
  response?: {
    status: number | null
    headers: Record<string, string>
    contentType?: string | null
    error?: string | null
  }
}

export interface OfficialClaudeRedactedCapture {
  schemaVersion: number
  capturedAt: string
  runtime: OfficialClaudeRawCapture["runtime"]
  request: {
    url: string
    method: string
    headers: Record<string, string>
    body: unknown
  }
  response?: OfficialClaudeRawCapture["response"]
}

export interface OfficialClaudeCapturePaths {
  rawPath: string
  redactedPath: string
}

interface HeaderRedactionState {
  index: number
}

function nextHeaderPlaceholder(state: HeaderRedactionState): string {
  state.index += 1
  return `[redacted-header-${state.index}]`
}

function sanitizeHeaderRecord(headers: Record<string, string>): Record<string, string> {
  const state: HeaderRedactionState = { index: 0 }
  const sanitized: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    sanitized[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase())
      ? nextHeaderPlaceholder(state)
      : value
  }

  return sanitized
}

function parseRedactedBody(body: unknown): unknown {
  if (body === null || body === undefined) return body
  if (typeof body === "string") {
    return sanitizeIncomingRequestBody(body)
  }

  return body
}

function getDefaultCaptureDirectory(
  cwd = process.cwd(),
  existsSyncImpl: typeof existsSync = existsSync
): string {
  if (existsSyncImpl("/captures")) {
    return "/captures/official-claude"
  }

  return join(cwd, "captures", "official-claude")
}

function joinCapturePath(directory: string, fileName: string): string {
  return directory.startsWith("/")
    ? posix.join(directory, fileName)
    : join(directory, fileName)
}

export function getOfficialClaudeCapturePaths(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  existsSyncImpl: typeof existsSync = existsSync
): OfficialClaudeCapturePaths {
  const directory =
    env.CLAUDE_OFFICIAL_CAPTURE_DIR?.trim() ||
    getDefaultCaptureDirectory(cwd, existsSyncImpl)

  return {
    rawPath:
      env.CLAUDE_OFFICIAL_CAPTURE_RAW_PATH?.trim() ||
      joinCapturePath(directory, "latest-raw.json"),
    redactedPath:
      env.CLAUDE_OFFICIAL_CAPTURE_REDACTED_PATH?.trim() ||
      joinCapturePath(directory, "latest-redacted.json")
  }
}

export function buildRedactedOfficialClaudeCapture(
  raw: OfficialClaudeRawCapture
): OfficialClaudeRedactedCapture {
  return {
    schemaVersion: raw.schemaVersion,
    capturedAt: raw.capturedAt,
    runtime: { ...raw.runtime },
    request: {
      url: raw.request.url,
      method: raw.request.method,
      headers: sanitizeHeaderRecord(raw.request.headers),
      body: parseRedactedBody(raw.request.body)
    },
    response: raw.response
      ? {
          ...raw.response,
          headers: sanitizeHeaderRecord(raw.response.headers)
        }
      : undefined
  }
}

export async function writeOfficialClaudeRawCapture(
  path: string,
  capture: OfficialClaudeRawCapture
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(capture, null, 2), "utf-8")
}

export async function writeOfficialClaudeRedactedCapture(
  path: string,
  capture: OfficialClaudeRedactedCapture
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(capture, null, 2), "utf-8")
}

function validateRawCapture(parsed: unknown, path: string): OfficialClaudeRawCapture {
  const capture = parsed as Partial<OfficialClaudeRawCapture>
  if (
    typeof capture !== "object" ||
    capture === null ||
    typeof capture.request?.url !== "string" ||
    typeof capture.request?.method !== "string" ||
    typeof capture.request?.headers !== "object" ||
    capture.request.headers === null
  ) {
    throw new Error(`Official Claude raw capture at ${path} is missing the request payload.`)
  }

  return capture as OfficialClaudeRawCapture
}

function validateRedactedCapture(parsed: unknown, path: string): OfficialClaudeRedactedCapture {
  const capture = parsed as Partial<OfficialClaudeRedactedCapture>
  if (
    typeof capture !== "object" ||
    capture === null ||
    typeof capture.request?.url !== "string" ||
    typeof capture.request?.method !== "string" ||
    typeof capture.request?.headers !== "object" ||
    capture.request.headers === null ||
    capture.request.body === undefined
  ) {
    throw new Error(`Official Claude redacted capture at ${path} is missing the request payload.`)
  }

  return capture as OfficialClaudeRedactedCapture
}

async function readCaptureJson(path: string, label: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(path, "utf-8")
  } catch (error) {
    throw new Error(
      `Failed to read ${label} at ${path}.\n` +
      (error instanceof Error ? error.message : String(error))
    )
  }

  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Failed to parse ${label} at ${path}.\n` +
      (error instanceof Error ? error.message : String(error))
    )
  }
}

export async function readOfficialClaudeRawCapture(
  path: string
): Promise<OfficialClaudeRawCapture> {
  const parsed = await readCaptureJson(path, "official Claude raw capture")
  return validateRawCapture(parsed, path)
}

export async function readOfficialClaudeRedactedCapture(
  path: string
): Promise<OfficialClaudeRedactedCapture> {
  const parsed = await readCaptureJson(path, "official Claude redacted capture")
  const capture = validateRedactedCapture(parsed, path)
  return {
    schemaVersion: capture.schemaVersion,
    capturedAt: capture.capturedAt,
    runtime: { ...capture.runtime },
    request: {
      url: capture.request.url,
      method: capture.request.method,
      headers: sanitizeHeaderRecord(capture.request.headers),
      body: parseRedactedBody(capture.request.body)
    },
    response: capture.response
      ? {
          ...capture.response,
          headers: sanitizeHeaderRecord(capture.response.headers)
        }
      : undefined
  }
}

export async function finalizeOfficialClaudeCapture(
  rawPath: string,
  redactedPath: string,
  expectedRunId?: string
): Promise<OfficialClaudeRedactedCapture> {
  const raw = await readOfficialClaudeRawCapture(rawPath)

  if (expectedRunId && raw.runtime.runId !== expectedRunId) {
    throw new Error(
      `Official Claude raw capture at ${rawPath} does not belong to the current run. ` +
      `Expected run id ${expectedRunId}, received ${raw.runtime.runId ?? "none"}.`
    )
  }

  const redacted = buildRedactedOfficialClaudeCapture(raw)
  await writeOfficialClaudeRedactedCapture(redactedPath, redacted)
  return redacted
}

export function createOfficialClaudeRawCapture(
  request: OfficialClaudeRawCapture["request"],
  runtime: OfficialClaudeRawCapture["runtime"],
  response?: OfficialClaudeRawCapture["response"]
): OfficialClaudeRawCapture {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    runtime,
    request,
    response
  }
}
