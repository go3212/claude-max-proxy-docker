import type { ClaudeProxySystemMode } from "./system-mode"

export interface ToolBridgeResult {
  mappedToolNames: Array<{ openName: string; officialName: string }>
  officialToOpenNames: Record<string, string>
  unsupportedToolNames: string[]
  hasTools: boolean
}

export type UnsupportedToolMode = "keep" | "drop"

const OPEN_TO_OFFICIAL_NAME: Record<string, string> = {
  task: "Agent",
  bash: "Bash",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  read: "Read",
  write: "Write",
  skill: "Skill"
}

const OPEN_TO_MCP_ALIAS_NAME: Record<string, string> = {
  get_environment: "mcp__environment__get_environment"
}

function reverseNameMap(): Record<string, string> {
  const reversed: Record<string, string> = {}
  for (const [openName, officialName] of Object.entries(OPEN_TO_OFFICIAL_NAME)) {
    reversed[officialName] = openName
  }
  return reversed
}

const OFFICIAL_TO_OPEN_NAME = reverseNameMap()

function buildMcpToolName(serverName: string, toolName: string): string | null {
  const normalizedServerName = serverName.replace(/^_+|_+$/g, "")
  const normalizedToolName = toolName.replace(/^_+|_+$/g, "")

  if (!normalizedServerName || !normalizedToolName) {
    return null
  }

  return `mcp__${normalizedServerName}__${normalizedToolName}`
}

function normalizeImplicitMcpToolName(openName: string): string | null {
  const prefixedServerMatch = openName.match(/^__([^_]+?)(?:__|_)(.+)$/)
  if (prefixedServerMatch) {
    const [, serverName = "", toolName = ""] = prefixedServerMatch
    return buildMcpToolName(serverName, toolName)
  }

  const dynamicConnectorMatch = openName.match(/^([a-f0-9]{6,32})_([a-f0-9]{6,32})_(.+)$/i)
  if (dynamicConnectorMatch) {
    const [, connectorA = "", connectorB = "", toolName = ""] = dynamicConnectorMatch
    return buildMcpToolName(
      `${connectorA}_${connectorB}`,
      toolName
    )
  }

  if (openName.includes("__")) {
    const [serverName, ...toolParts] = openName.split("__").filter(Boolean)
    return buildMcpToolName(serverName ?? "", toolParts.join("__"))
  }

  return null
}

function normalizeSyntheticLocalMcpToolName(openName: string): string | null {
  const normalizedName = openName.trim().replace(/^_+|_+$/g, "")
  if (!normalizedName) return null
  if (!/^[A-Za-z0-9_-]+$/.test(normalizedName)) return null
  return buildMcpToolName("local", normalizedName)
}

function resolveOfficialToolName(
  openName: string,
  systemMode: ClaudeProxySystemMode = "official"
): string | null {
  const lower = openName.toLowerCase()
  if (OPEN_TO_OFFICIAL_NAME[lower]) {
    return OPEN_TO_OFFICIAL_NAME[lower]
  }

  if (OPEN_TO_MCP_ALIAS_NAME[lower]) {
    return OPEN_TO_MCP_ALIAS_NAME[lower]
  }

  if (OFFICIAL_TO_OPEN_NAME[openName]) {
    return openName
  }

  if (openName.startsWith("mcp__")) {
    return openName
  }

  if (openName.startsWith("mcp_")) {
    const suffix = openName.slice(4)
    const normalizedSuffix = normalizeImplicitMcpToolName(suffix)
    if (normalizedSuffix) {
      return normalizedSuffix
    }

    const prefixedServerMatch = suffix.match(/^([^_]+)_(.+)$/)
    if (prefixedServerMatch) {
      const [, serverName = "", toolName = ""] = prefixedServerMatch
      return buildMcpToolName(serverName, toolName)
    }

    return suffix ? `mcp__${suffix}` : null
  }

  const normalizedImplicitName = normalizeImplicitMcpToolName(openName)
  if (normalizedImplicitName) {
    return normalizedImplicitName
  }

  if (systemMode === "hermes-minimal") {
    return normalizeSyntheticLocalMcpToolName(openName)
  }

  return null
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function mapToolBlockNamesInMessages(
  messages: unknown,
  officialToOpen: Record<string, string>,
  direction: "open-to-official" | "official-to-open",
  systemMode: ClaudeProxySystemMode = "official"
): void {
  if (!Array.isArray(messages)) return

  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue
    const typedMessage = message as Record<string, unknown>
    if (!Array.isArray(typedMessage.content)) continue

    for (const block of typedMessage.content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue
      const typedBlock = block as Record<string, unknown>
      if (typedBlock.type !== "tool_use" || typeof typedBlock.name !== "string") continue

      const mappedName = direction === "open-to-official"
        ? resolveOfficialToolName(typedBlock.name, systemMode)
        : officialToOpen[typedBlock.name]
      if (mappedName) {
        typedBlock.name = mappedName
      }
    }
  }
}

export function applyRequestToolBridge(
  body: Record<string, unknown>,
  mode: UnsupportedToolMode,
  systemMode: ClaudeProxySystemMode = "official"
): ToolBridgeResult {
  const incomingTools = Array.isArray(body.tools) ? body.tools : []
  const outgoingTools: unknown[] = []
  const mappedToolNames: Array<{ openName: string; officialName: string }> = []
  const officialToOpenNames: Record<string, string> = {}
  const unsupportedToolNames: string[] = []

  for (const tool of incomingTools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      outgoingTools.push(tool)
      continue
    }

    const typedTool = cloneValue(tool as Record<string, unknown>)
    const openName = typeof typedTool.name === "string" ? typedTool.name : ""
    const officialName = resolveOfficialToolName(openName, systemMode)

    if (officialName) {
      mappedToolNames.push({ openName, officialName })
      officialToOpenNames[officialName] = openName
      typedTool.name = officialName
      outgoingTools.push(typedTool)
      continue
    }

    unsupportedToolNames.push(openName)
    if (mode === "keep") {
      outgoingTools.push(typedTool)
    }
  }

  if (incomingTools.length > 0 || mode === "drop") {
    body.tools = outgoingTools
  }

  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    const typedChoice = body.tool_choice as Record<string, unknown>
    if (typedChoice.type === "tool" && typeof typedChoice.name === "string") {
      const officialName = resolveOfficialToolName(typedChoice.name, systemMode)
      if (officialName) {
        typedChoice.name = officialName
      } else if (mode === "drop") {
        body.tool_choice = { type: "auto" }
      }
    }
  }

  mapToolBlockNamesInMessages(
    body.messages,
    OFFICIAL_TO_OPEN_NAME,
    "open-to-official",
    systemMode
  )

  return {
    mappedToolNames,
    officialToOpenNames,
    unsupportedToolNames,
    hasTools: outgoingTools.length > 0
  }
}

function rewriteToolUseNames(value: unknown, officialToOpenNames: Record<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteToolUseNames(entry, officialToOpenNames))
  }

  if (!value || typeof value !== "object") return value

  const typedValue = value as Record<string, unknown>
  const rewritten: Record<string, unknown> = {}

  for (const [key, entry] of Object.entries(typedValue)) {
    if (
      key === "name" &&
      typedValue.type === "tool_use" &&
      typeof entry === "string" &&
      officialToOpenNames[entry]
    ) {
      rewritten[key] = officialToOpenNames[entry]
      continue
    }

    rewritten[key] = rewriteToolUseNames(entry, officialToOpenNames)
  }

  return rewritten
}

export function rewriteResponseJsonToolNames<T>(
  value: T,
  officialToOpenNames: Record<string, string>
): T {
  return rewriteToolUseNames(value, officialToOpenNames) as T
}

function createSseFrame(eventName: string | null, payload: unknown): string {
  const lines: string[] = []
  if (eventName) {
    lines.push(`event: ${eventName}`)
  }
  lines.push(`data: ${JSON.stringify(payload)}`)
  return `${lines.join("\n")}\n\n`
}

function processSseFrame(frame: string, officialToOpenNames: Record<string, string>): string {
  const trimmed = frame.trim()
  if (!trimmed) return frame

  const lines = frame.split(/\r?\n/)
  const eventLine = lines.find((line) => line.startsWith("event:"))
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())

  if (dataLines.length === 0) return frame

  const data = dataLines.join("\n")
  if (data === "[DONE]") return frame

  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    const rewritten = rewriteResponseJsonToolNames(parsed, officialToOpenNames)
    return createSseFrame(
      eventLine ? eventLine.slice(6).trim() : null,
      rewritten
    )
  } catch {
    return frame
  }
}

export function rewriteSseBodyToolNames(
  body: ReadableStream<Uint8Array>,
  officialToOpenNames: Record<string, string>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const reader = body.getReader()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        let separatorIndex = buffer.indexOf("\n\n")
        while (separatorIndex !== -1) {
          const frame = buffer.slice(0, separatorIndex + 2)
          buffer = buffer.slice(separatorIndex + 2)
          controller.enqueue(encoder.encode(processSseFrame(frame, officialToOpenNames)))
          separatorIndex = buffer.indexOf("\n\n")
        }
      }

      if (buffer) {
        controller.enqueue(encoder.encode(processSseFrame(buffer, officialToOpenNames)))
      }

      controller.close()
    }
  })
}
