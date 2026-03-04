import { Hono } from "hono"
import { cors } from "hono/cors"
import type { Context } from "hono"
import type { ProxyConfig, ClaudeCredentials } from "./types"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { claudeLog } from "../logger"
import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
const TOKEN_REFRESH_URL = "https://platform.claude.com/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const OAUTH_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers"
const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json")

let credentials: ClaudeCredentials

function loadCredentials(): ClaudeCredentials {
  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf-8")
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Failed to load credentials from ${CREDENTIALS_PATH}. Run 'claude login' first.\n` +
      (error instanceof Error ? error.message : String(error))
    )
  }
}

async function refreshToken(): Promise<void> {
  claudeLog("auth.refreshing")
  const res = await fetch(TOKEN_REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: credentials.claudeAiOauth.refreshToken,
      client_id: OAUTH_CLIENT_ID,
      scope: OAUTH_SCOPES
    })
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Token refresh failed (${res.status}): ${body}`)
  }

  const data = await res.json() as {
    access_token: string
    refresh_token: string
    expires_in: number
  }

  credentials.claudeAiOauth.accessToken = data.access_token
  credentials.claudeAiOauth.refreshToken = data.refresh_token
  credentials.claudeAiOauth.expiresAt = Date.now() + data.expires_in * 1000
  claudeLog("auth.refreshed", { expiresAt: credentials.claudeAiOauth.expiresAt })
}

async function ensureValidToken(): Promise<string> {
  if (Date.now() >= credentials.claudeAiOauth.expiresAt - 60_000) {
    await refreshToken()
  }
  return credentials.claudeAiOauth.accessToken
}

export function createProxyServer(config: Partial<ProxyConfig> = {}) {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }
  const app = new Hono()

  credentials = loadCredentials()
  claudeLog("auth.loaded", {
    subscriptionType: credentials.claudeAiOauth.subscriptionType,
    expiresAt: credentials.claudeAiOauth.expiresAt
  })

  app.use("*", cors())

  app.get("/", (c) => {
    return c.json({
      status: "ok",
      service: "claude-max-proxy",
      version: "2.0.0",
      mode: "passthrough",
      endpoints: ["/v1/messages", "/messages"]
    })
  })

  const handleMessages = async (c: Context) => {
    try {
      const token = await ensureValidToken()
      const body = await c.req.text()

      claudeLog("proxy.request", {
        contentLength: body.length,
        hasStream: body.includes('"stream"')
      })

      const headers: Record<string, string> = {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-app": "cli",
        "User-Agent": "claude-cli/2.1.68"
      }

      // Forward anthropic-beta header if present
      const betaHeader = c.req.header("anthropic-beta")
      if (betaHeader) {
        headers["anthropic-beta"] = betaHeader
      }

      const upstream = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers,
        body
      })

      claudeLog("proxy.response", { status: upstream.status })

      // Pipe the response directly back
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("Content-Type") || "application/json",
          ...(upstream.headers.get("Cache-Control") && {
            "Cache-Control": upstream.headers.get("Cache-Control")!
          })
        }
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

  return { app, config: finalConfig }
}

export async function startProxyServer(config: Partial<ProxyConfig> = {}) {
  const { app, config: finalConfig } = createProxyServer(config)

  const server = Bun.serve({
    port: finalConfig.port,
    hostname: finalConfig.host,
    fetch: app.fetch
  })

  console.log(`Claude Max Proxy (passthrough) running at http://${finalConfig.host}:${finalConfig.port}`)
  console.log(`Supports: prompt caching, extended thinking, vision, tool use, PDFs, streaming`)
  console.log(`\nTo use with OpenCode:`)
  console.log(`  ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://${finalConfig.host}:${finalConfig.port} opencode`)

  return server
}
