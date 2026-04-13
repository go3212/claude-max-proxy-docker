import { Hono } from "hono"
import { cors } from "hono/cors"
import type { Context } from "hono"
import type { ProxyConfig } from "./types"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { claudeLog } from "../logger"
import { getValidCredentials } from "./credentials"
import { buildRequestHeaders } from "./headers"
import { transformBodyString } from "./transforms"
import { resolveClaudeCodeVersion } from "./version"

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"

function buildResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers()
  for (const [key, value] of upstreamHeaders) {
    const lower = key.toLowerCase()
    if (
      lower === "connection" ||
      lower === "keep-alive" ||
      lower === "transfer-encoding" ||
      lower === "content-length"
    ) {
      continue
    }
    headers.set(key, value)
  }
  return headers
}

export function createProxyServer(config: Partial<ProxyConfig> = {}) {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }
  const claudeCodeVersion = resolveClaudeCodeVersion()
  const claudeCodeEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli"
  const app = new Hono()

  app.use("*", cors())

  app.get("/", (c) => {
    return c.json({
      status: "ok",
      service: "claude-max-proxy",
      version: "2.1.0",
      mode: "passthrough",
      authMode: "opencode-claude-auth-server",
      claudeCodeVersion,
      endpoints: ["/v1/messages", "/messages"]
    })
  })

  const handleMessages = async (c: Context) => {
    try {
      const credentials = await getValidCredentials()
      const rawBody = await c.req.text()
      const transformedBody = transformBodyString(rawBody, {
        version: claudeCodeVersion,
        entrypoint: claudeCodeEntrypoint
      })

      claudeLog("proxy.request", {
        contentLength: rawBody.length,
        hasStream: transformedBody.stream,
        modelId: transformedBody.modelId,
        transformed: transformedBody.transformed
      })

      const headers = buildRequestHeaders(
        c.req.raw.headers,
        credentials.claudeAiOauth.accessToken,
        transformedBody.modelId,
        claudeCodeVersion
      )
      headers.set("content-type", "application/json")

      const upstream = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers,
        body: transformedBody.body
      })

      claudeLog("proxy.response", {
        status: upstream.status,
        modelId: transformedBody.modelId
      })

      return new Response(upstream.body, {
        status: upstream.status,
        headers: buildResponseHeaders(upstream.headers)
      })
    } catch (error) {
      claudeLog("proxy.error", { error: error instanceof Error ? error.message : String(error) })
      return c.json({
        type: "error",
        error: {
          type: "api_error",
          message: error instanceof Error ? error.message : "Unknown error"
        }
      }, 500)
    }
  }

  app.post("/v1/messages", handleMessages)
  app.post("/messages", handleMessages)

  return { app, config: finalConfig, claudeCodeVersion }
}

export async function startProxyServer(config: Partial<ProxyConfig> = {}) {
  const { app, config: finalConfig, claudeCodeVersion } = createProxyServer(config)

  const server = Bun.serve({
    port: finalConfig.port,
    hostname: finalConfig.host,
    fetch: app.fetch
  })

  console.log(`Claude Max Proxy (opencode-claude-auth server) running at http://${finalConfig.host}:${finalConfig.port}`)
  console.log(`Claude Code parity version: ${claudeCodeVersion}`)
  console.log(`Supports: prompt caching, extended thinking, vision, tool use, PDFs, streaming`)
  console.log(`\nTo use with OpenCode:`)
  console.log(`  ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://${finalConfig.host}:${finalConfig.port} opencode`)

  return server
}
