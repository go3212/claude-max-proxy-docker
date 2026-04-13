import { URL } from "node:url"
import { getOfficialClaudeCapturePaths, readOfficialClaudeRawCapture } from "../official-claude/capture"
import type { AnthropicRequestBody, SystemEntry } from "./transforms"

const DEFAULT_UPSTREAM_URL = "https://api.anthropic.com/v1/messages?beta=true"
const DEFAULT_STAINLESS_PACKAGE_VERSION = "0.81.0"

export interface OfficialClaudeScaffold {
  source: "raw-capture" | "fallback"
  capturePath: string | null
  upstreamUrl: string
  path: string
  query: string
  entrypoint: string
  headerTemplate: Record<string, string>
  bodyTemplate: AnthropicRequestBody
}

let cachedScaffold: Promise<OfficialClaudeScaffold> | null = null

function normalizeOs(): string {
  switch (process.platform) {
    case "win32":
      return "Windows"
    case "darwin":
      return "MacOS"
    default:
      return "Linux"
  }
}

function buildFallbackScaffold(): OfficialClaudeScaffold {
  const upstreamUrl = new URL(DEFAULT_UPSTREAM_URL)
  return {
    source: "fallback",
    capturePath: null,
    upstreamUrl: upstreamUrl.toString(),
    path: upstreamUrl.pathname,
    query: upstreamUrl.search,
    entrypoint: "sdk-cli",
    headerTemplate: {
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "user-agent": "claude-cli/0.0.0 (external, sdk-cli)",
      "x-app": "cli",
      "x-stainless-arch": process.arch,
      "x-stainless-lang": "js",
      "x-stainless-os": normalizeOs(),
      "x-stainless-package-version": DEFAULT_STAINLESS_PACKAGE_VERSION,
      "x-stainless-retry-count": "0",
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": `v${process.versions.node}`,
      "x-stainless-timeout": "600"
    },
    bodyTemplate: {
      system: [],
      tools: [],
      metadata: {},
      context_management: {
        edits: [
          {
            type: "clear_thinking_20251015",
            keep: "summary"
          }
        ]
      },
      stream: true
    }
  }
}

function deriveEntrypointFromUserAgent(userAgent: string | undefined): string {
  if (!userAgent) return "cli"
  const match = userAgent.match(/\(external,\s*([^)]+)\)/i)
  return match?.[1]?.trim() || "cli"
}

function getCapturePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.CLAUDE_PROXY_OFFICIAL_CAPTURE_RAW_PATH?.trim() ||
    env.CLAUDE_OFFICIAL_CAPTURE_RAW_PATH?.trim() ||
    getOfficialClaudeCapturePaths(process.cwd(), env).rawPath
  )
}

function normalizeBodyTemplate(value: unknown): AnthropicRequestBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }

  return JSON.parse(JSON.stringify(value)) as AnthropicRequestBody
}

function normalizeSystem(system: AnthropicRequestBody["system"]): Array<SystemEntry | string> {
  if (typeof system === "string") {
    return system ? [{ type: "text", text: system }] : []
  }

  if (Array.isArray(system)) {
    return JSON.parse(JSON.stringify(system)) as Array<SystemEntry | string>
  }

  return []
}

export async function resolveOfficialClaudeScaffold(
  env: NodeJS.ProcessEnv = process.env
): Promise<OfficialClaudeScaffold> {
  if (env === process.env && cachedScaffold) {
    return cachedScaffold
  }

  const load = async (): Promise<OfficialClaudeScaffold> => {
    const capturePath = getCapturePath(env)
    try {
      const raw = await readOfficialClaudeRawCapture(capturePath)
      const parsedUrl = new URL(raw.request.url)
      const body = raw.request.body ? JSON.parse(raw.request.body) as unknown : {}
      const bodyTemplate = normalizeBodyTemplate(body)
      bodyTemplate.system = normalizeSystem(bodyTemplate.system)

      return {
        source: "raw-capture",
        capturePath,
        upstreamUrl: parsedUrl.toString(),
        path: parsedUrl.pathname,
        query: parsedUrl.search,
        entrypoint: deriveEntrypointFromUserAgent(raw.request.headers["user-agent"]),
        headerTemplate: { ...raw.request.headers },
        bodyTemplate
      }
    } catch {
      return buildFallbackScaffold()
    }
  }

  const pending = load()
  if (env === process.env) {
    cachedScaffold = pending
  }
  return pending
}

export function cloneOfficialClaudeBodyTemplate(
  scaffold: OfficialClaudeScaffold
): AnthropicRequestBody {
  return JSON.parse(JSON.stringify(scaffold.bodyTemplate)) as AnthropicRequestBody
}

export function getOfficialToolTemplateMap(
  scaffold: OfficialClaudeScaffold
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  const tools = Array.isArray(scaffold.bodyTemplate.tools)
    ? scaffold.bodyTemplate.tools
    : []

  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue
    const typedTool = tool as Record<string, unknown>
    if (typeof typedTool.name !== "string") continue
    map.set(typedTool.name.toLowerCase(), JSON.parse(JSON.stringify(typedTool)) as Record<string, unknown>)
  }

  return map
}

export function resetOfficialClaudeScaffoldCache(): void {
  cachedScaffold = null
}
