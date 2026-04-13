import { readCapturedRequestFixture } from "./capture"
import { createProxyServer } from "./server"
import {
  buildValidationExcerpt,
  summarizeAnthropicResponse,
  type ValidationSummary
} from "./validation"

export interface ProxyValidationRequest {
  method: string
  path: string
  headers?: RequestInit["headers"]
  body: string
  model?: string
}

export interface ProxyValidationResult {
  status: number
  model: string
  claudeCodeVersion: string
  summary: ValidationSummary
  excerpt: string
  accepted: boolean
}

function inferModel(body: string, fallback = "unknown"): string {
  try {
    const parsed = JSON.parse(body) as { model?: string }
    return typeof parsed.model === "string" ? parsed.model : fallback
  } catch {
    return fallback
  }
}

export async function runProxyValidationRequest(
  request: ProxyValidationRequest
): Promise<ProxyValidationResult> {
  const { app, claudeCodeVersion } = createProxyServer()
  const response = await app.request(`http://localhost${request.path}`, {
    method: request.method,
    headers: request.headers,
    body: request.body
  })

  const rawBody = await response.text()
  const summary = summarizeAnthropicResponse(rawBody)
  const excerpt = buildValidationExcerpt(summary)
  const accepted =
    response.ok &&
    !summary.isThirdPartyUsage &&
    !summary.errorMessage &&
    Boolean(summary.assistantText || rawBody.trim())

  return {
    status: response.status,
    model: request.model ?? inferModel(request.body),
    claudeCodeVersion,
    summary,
    excerpt,
    accepted
  }
}

export async function runCapturedRequestValidation(
  fixturePath: string
): Promise<ProxyValidationResult> {
  const fixture = await readCapturedRequestFixture(fixturePath)

  return runProxyValidationRequest({
    method: fixture.request.method,
    path: fixture.request.path,
    headers: fixture.request.headers,
    body: JSON.stringify(fixture.request.body),
    model: fixture.proxy.modelId
  })
}
