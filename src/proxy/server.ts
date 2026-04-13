import { Hono } from "hono"
import { cors } from "hono/cors"
import type { Context } from "hono"
import type { ProxyConfig } from "./types"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { claudeLog } from "../logger"
import {
  buildCapturedRequestFixture,
  writeCapturedRequestFixture
} from "./capture"
import { getValidCredentials } from "./credentials"
import { prepareRequestHeaders } from "./headers"
import { transformBodyString } from "./transforms"
import { summarizeAnthropicResponse } from "./validation"
import { resolveClaudeCodeMetadata } from "./version"

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"

function buildResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers()
  for (const [key, value] of upstreamHeaders) {
    const lower = key.toLowerCase()
    if (
      lower === "connection" ||
      lower === "keep-alive" ||
      lower === "transfer-encoding" ||
      lower === "content-length" ||
      lower === "content-encoding"
    ) {
      continue
    }
    headers.set(key, value)
  }
  return headers
}

export function createProxyServer(config: Partial<ProxyConfig> = {}) {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }
  const claudeCodeMetadata = resolveClaudeCodeMetadata()
  const claudeCodeVersion = claudeCodeMetadata.version
  const claudeCodeEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli"
  const capturePath = process.env.CLAUDE_PROXY_CAPTURE_PATH
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
      claudeCodeVersionSource: claudeCodeMetadata.source,
      endpoints: ["/v1/messages", "/messages"]
    })
  })

  const handleMessages = async (c: Context) => {
    try {
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

      const credentials = await getValidCredentials()
      const headerBuild = prepareRequestHeaders(
        c.req.raw.headers,
        credentials.claudeAiOauth.accessToken,
        transformedBody.modelId,
        claudeCodeVersion
      )

      if (capturePath) {
        const fixture = buildCapturedRequestFixture({
          method: c.req.method,
          path: new URL(c.req.url).pathname,
          headers: c.req.raw.headers,
          rawBody,
          claudeCodeVersion,
          entrypoint: claudeCodeEntrypoint,
          modelId: transformedBody.modelId,
          stream: transformedBody.stream,
          transformed: transformedBody.transformed,
          betas: headerBuild.betas,
          summary: transformedBody.summary,
          outgoingHeaders: headerBuild.headers,
          outgoingBody: transformedBody.body,
          droppedIncomingHeaders: headerBuild.droppedIncomingHeaders,
          droppedIncomingBetas: headerBuild.droppedIncomingBetas
        })

        try {
          await writeCapturedRequestFixture(capturePath, fixture)
          claudeLog("proxy.capture.write", {
            path: capturePath,
            route: fixture.request.path,
            modelId: transformedBody.modelId
          })
        } catch (error) {
          claudeLog("proxy.capture.failed", {
            path: capturePath,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }

      claudeLog("proxy.request.shape", {
        modelId: transformedBody.modelId,
        version: claudeCodeVersion,
        versionSource: claudeCodeMetadata.source,
        entrypoint: claudeCodeEntrypoint,
        betas: headerBuild.betas,
        droppedIncomingBetas: headerBuild.droppedIncomingBetas,
        droppedIncomingHeaders: headerBuild.droppedIncomingHeaders,
        outboundHeaders: headerBuild.debugHeaders,
        ...transformedBody.summary
      })

      const upstream = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: headerBuild.headers,
        body: transformedBody.body
      })
      const shouldSummarizeResponse = !upstream.ok || !transformedBody.stream
      const validationSummary = shouldSummarizeResponse
        ? summarizeAnthropicResponse(await upstream.clone().text())
        : null

      claudeLog("proxy.response", {
        status: upstream.status,
        modelId: transformedBody.modelId,
        thirdPartyUsageDetected: validationSummary?.isThirdPartyUsage ?? false,
        errorMessage: validationSummary?.errorMessage ?? null,
        message: validationSummary?.message ?? null
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

  return { app, config: finalConfig, claudeCodeVersion, claudeCodeMetadata }
}

export async function startProxyServer(config: Partial<ProxyConfig> = {}) {
  const { app, config: finalConfig, claudeCodeVersion, claudeCodeMetadata } = createProxyServer(config)
  const capturePath = process.env.CLAUDE_PROXY_CAPTURE_PATH

  const server = Bun.serve({
    port: finalConfig.port,
    hostname: finalConfig.host,
    fetch: app.fetch
  })

  console.log(`Claude Max Proxy (opencode-claude-auth server) running at http://${finalConfig.host}:${finalConfig.port}`)
  console.log(`Claude Code parity version: ${claudeCodeVersion} (source: ${claudeCodeMetadata.source})`)
  if (claudeCodeMetadata.binaryPath) {
    console.log(`Claude binary path: ${claudeCodeMetadata.binaryPath}`)
  }
  if (claudeCodeMetadata.packagePath) {
    console.log(`Claude package path: ${claudeCodeMetadata.packagePath}`)
  }
  console.log(`Supports: prompt caching, extended thinking, vision, tool use, PDFs, streaming`)
  if (capturePath) {
    console.log(`Redacted capture path: ${capturePath}`)
  }
  console.log(`\nTo use with OpenCode:`)
  console.log(`  ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://${finalConfig.host}:${finalConfig.port} opencode`)

  return server
}
