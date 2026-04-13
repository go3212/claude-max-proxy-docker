const THIRD_PARTY_USAGE_FRAGMENT =
  "third-party apps now draw from your extra usage"

const THIRD_PARTY_USAGE_SUPPORTING_FRAGMENTS = [
  "$200 credit",
  "claude.ai/settings/usage"
]

export interface ValidationSummary {
  assistantText: string | null
  errorMessage: string | null
  message: string | null
  isThirdPartyUsage: boolean
}

function joinTextBlocks(
  content: Array<{ type?: string; text?: string }>
): string | null {
  const text = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("")
    .trim()

  return text || null
}

export function detectThirdPartyUsageClassification(
  text: string | null | undefined
): boolean {
  if (!text) return false

  const lower = text.toLowerCase()
  return (
    lower.includes(THIRD_PARTY_USAGE_FRAGMENT) ||
    THIRD_PARTY_USAGE_SUPPORTING_FRAGMENTS.every((fragment) =>
      lower.includes(fragment.toLowerCase())
    )
  )
}

export function summarizeAnthropicResponse(rawBody: string): ValidationSummary {
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { message?: string; type?: string }
      content?: Array<{ type?: string; text?: string }>
      message?: string
    }

    const assistantText = Array.isArray(parsed.content)
      ? joinTextBlocks(parsed.content)
      : null
    const errorMessage =
      parsed.error?.message ??
      parsed.error?.type ??
      null
    const message = errorMessage ?? assistantText ?? parsed.message ?? null

    return {
      assistantText,
      errorMessage,
      message,
      isThirdPartyUsage: detectThirdPartyUsageClassification(message)
    }
  } catch {
    const message = rawBody.trim() || null
    return {
      assistantText: null,
      errorMessage: null,
      message,
      isThirdPartyUsage: detectThirdPartyUsageClassification(message)
    }
  }
}

export function buildValidationExcerpt(
  summary: ValidationSummary,
  maxLength = 240
): string {
  const source = summary.message ?? ""
  if (source.length <= maxLength) return source
  return `${source.slice(0, maxLength - 3)}...`
}
