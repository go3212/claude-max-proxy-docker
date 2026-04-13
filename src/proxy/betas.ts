import { config, getModelOverride } from "./model-config"

export interface BetaBuildOptions {
  baseBetas?: string[]
  hasTools?: boolean
}

const TOOL_ONLY_BETAS = [
  "advisor-tool-2026-03-01",
  "advanced-tool-use-2025-11-20"
]

function getRequiredBetas(baseBetas?: string[]): string[] {
  return (process.env.ANTHROPIC_BETA_FLAGS ?? (baseBetas ?? config.baseBetas).join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function isEnable1mContext(): boolean {
  return process.env.ANTHROPIC_ENABLE_1M_CONTEXT === "true"
}

export function supports1mContext(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  if (!lower.includes("opus") && !lower.includes("sonnet")) return false

  const versionMatch = lower.match(/(opus|sonnet)-(\d+)-(\d+)/)
  if (!versionMatch) return false

  const major = Number.parseInt(versionMatch[2] ?? "", 10)
  const minor = Number.parseInt(versionMatch[3] ?? "", 10)
  if (Number.isNaN(major) || Number.isNaN(minor)) return false

  const effectiveMinor = minor > 99 ? 0 : minor
  return major > 4 || (major === 4 && effectiveMinor >= 6)
}

export function getModelBetas(modelId: string, options: BetaBuildOptions = {}): string[] {
  const betas = [...getRequiredBetas(options.baseBetas)]

  const primaryLongContextBeta = config.longContextBetas[0]
  const canUseLongContext = supports1mContext(modelId)
  if (primaryLongContextBeta && (!isEnable1mContext() || !canUseLongContext)) {
    const index = betas.indexOf(primaryLongContextBeta)
    if (index !== -1) betas.splice(index, 1)
  }

  if (primaryLongContextBeta && isEnable1mContext() && canUseLongContext) {
    betas.push(primaryLongContextBeta)
  }

  const override = getModelOverride(modelId)
  if (override?.exclude) {
    for (const excluded of override.exclude) {
      const index = betas.indexOf(excluded)
      if (index !== -1) betas.splice(index, 1)
    }
  }

  if (override?.add) {
    for (const addition of override.add) {
      if (!betas.includes(addition)) {
        betas.push(addition)
      }
    }
  }

  if (!options.hasTools) {
    for (const toolBeta of TOOL_ONLY_BETAS) {
      const index = betas.indexOf(toolBeta)
      if (index !== -1) betas.splice(index, 1)
    }
  }

  return [...new Set(betas)]
}
