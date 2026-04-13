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
import { resolveOfficialClaudeScaffold } from "./official-scaffold"
import {
  rewriteResponseJsonToolNames,
  rewriteSseBodyToolNames
} from "./tool-bridge"
import { summarizeAnthropicResponse } from "./validation"
import { resolveClaudeCodeMetadata } from "./version"

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
      const scaffold = await resolveOfficialClaudeScaffold()
      const claudeCodeEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? scaffold.entrypoint
      const credentials = await getValidCredentials()

      const metadataUserId =
        process.env.CLAUDE_PROXY_METADATA_USER_ID?.trim() ||
        null

      const buildRequestAttempt = (unsupportedToolMode: "keep" | "drop") => {
        const transformedBody = transformBodyString(rawBody, {
          version: claudeCodeVersion,
          entrypoint: claudeCodeEntrypoint,
          scaffold,
          unsupportedToolMode,
          metadataUserId
        })

        const headerBuild = prepareRequestHeaders(
          c.req.raw.headers,
          credentials.claudeAiOauth.accessToken,
          transformedBody.modelId,
          claudeCodeVersion,
          scaffold,
          transformedBody.toolBridge.hasTools
        )

        return {
          transformedBody,
          headerBuild
        }
      }

      const firstAttempt = buildRequestAttempt("keep")
      let transformedBody = firstAttempt.transformedBody
      let headerBuild = firstAttempt.headerBuild

      claudeLog("proxy.request", {
        contentLength: rawBody.length,
        hasStream: transformedBody.stream,
        modelId: transformedBody.modelId,
        transformed: transformedBody.transformed
      })

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
        scaffoldSource: scaffold.source,
        scaffoldPath: scaffold.capturePath,
        entrypoint: claudeCodeEntrypoint,
        upstreamUrl: headerBuild.upstreamUrl,
        betas: headerBuild.betas,
        droppedIncomingBetas: headerBuild.droppedIncomingBetas,
        droppedIncomingHeaders: headerBuild.droppedIncomingHeaders,
        outboundHeaders: headerBuild.debugHeaders,
        mappedTools: transformedBody.toolBridge.mappedToolNames,
        unsupportedTools: transformedBody.toolBridge.unsupportedToolNames,
        ...transformedBody.summary
      })

      let upstream = await fetch(headerBuild.upstreamUrl, {
        method: "POST",
        headers: headerBuild.headers,
        body: transformedBody.body
      })
      let validationSummary = !upstream.ok || !transformedBody.stream
        ? summarizeAnthropicResponse(await upstream.clone().text())
        : null

      if (
        !upstream.ok &&
        validationSummary?.isThirdPartyUsage &&
        transformedBody.toolBridge.unsupportedToolNames.length > 0
      ) {
        claudeLog("proxy.retry.unsupportedToolsDropped", {
          modelId: transformedBody.modelId,
          droppedUnsupportedTools: transformedBody.toolBridge.unsupportedToolNames
        })

        const retryAttempt = buildRequestAttempt("drop")
        transformedBody = retryAttempt.transformedBody
        headerBuild = retryAttempt.headerBuild
        upstream = await fetch(headerBuild.upstreamUrl, {
          method: "POST",
          headers: headerBuild.headers,
          body: transformedBody.body
        })
        validationSummary = !upstream.ok || !transformedBody.stream
          ? summarizeAnthropicResponse(await upstream.clone().text())
          : null
      }

      claudeLog("proxy.response", {
        status: upstream.status,
        modelId: transformedBody.modelId,
        thirdPartyUsageDetected: validationSummary?.isThirdPartyUsage ?? false,
        errorMessage: validationSummary?.errorMessage ?? null,
        message: validationSummary?.message ?? null,
        mappedTools: transformedBody.toolBridge.mappedToolNames,
        unsupportedTools: transformedBody.toolBridge.unsupportedToolNames
      })

      const responseHeaders = buildResponseHeaders(upstream.headers)
      const contentType = upstream.headers.get("content-type") ?? ""
      if (upstream.body && Object.keys(transformedBody.toolBridge.officialToOpenNames).length > 0) {
        if (contentType.includes("text/event-stream")) {
          return new Response(
            rewriteSseBodyToolNames(upstream.body, transformedBody.toolBridge.officialToOpenNames),
            {
              status: upstream.status,
              headers: responseHeaders
            }
          )
        }

        if (contentType.includes("application/json")) {
          const parsed = rewriteResponseJsonToolNames(
            JSON.parse(await upstream.text()) as unknown,
            transformedBody.toolBridge.officialToOpenNames
          )
          return new Response(JSON.stringify(parsed), {
            status: upstream.status,
            headers: responseHeaders
          })
        }
      }

      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders
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
