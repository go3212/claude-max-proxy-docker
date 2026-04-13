import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { config } from "./model-config"

const VERSION_PATTERN = /(\d+\.\d+\.\d+)/
const PACKAGE_RELATIVE_PATH = join("@anthropic-ai", "claude-code", "package.json")

export type ClaudeCodeVersionSource =
  | "env:CLAUDE_PROXY_CLAUDE_CODE_VERSION"
  | "env:ANTHROPIC_CLI_VERSION"
  | "claude --version"
  | "global package.json"
  | "fallback"

export interface InstalledClaudeCodeInfo {
  binaryPath: string | null
  cliVersion: string | null
  packagePath: string | null
  packageVersion: string | null
}

export interface ClaudeCodeMetadata extends InstalledClaudeCodeInfo {
  version: string
  source: ClaudeCodeVersionSource
  strictRequired: boolean
}

interface VersionResolutionDeps {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  execFileSyncImpl?: typeof execFileSync
  existsSyncImpl?: typeof existsSync
  readFileSyncImpl?: typeof readFileSync
}

let cachedMetadata: ClaudeCodeMetadata | null = null

function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== "" && normalized !== "0" && normalized !== "false"
}

function parseVersion(raw: string): string | null {
  const match = raw.match(VERSION_PATTERN)
  return match?.[1] ?? null
}

function resolveCommandLookupBinary(platform: NodeJS.Platform): string {
  return platform === "win32" ? "where.exe" : "which"
}

function resolveClaudeBinaryPath(
  deps: Required<Pick<VersionResolutionDeps, "platform" | "execFileSyncImpl">>
): string | null {
  try {
    const raw = deps.execFileSyncImpl(
      resolveCommandLookupBinary(deps.platform),
      ["claude"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    )
    const firstLine = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)

    return firstLine ?? null
  } catch {
    return null
  }
}

function resolveCliVersion(
  deps: Required<Pick<VersionResolutionDeps, "execFileSyncImpl">>
): string | null {
  try {
    const raw = deps.execFileSyncImpl("claude", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    })
    return parseVersion(raw)
  } catch {
    return null
  }
}

function resolveGlobalPackagePath(
  deps: Required<Pick<VersionResolutionDeps, "execFileSyncImpl" | "existsSyncImpl">>
): string | null {
  try {
    const globalRoot = deps.execFileSyncImpl("npm", ["root", "-g"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim()
    if (!globalRoot) return null

    const packagePath = join(globalRoot, PACKAGE_RELATIVE_PATH)
    return deps.existsSyncImpl(packagePath) ? packagePath : null
  } catch {
    return null
  }
}

function resolveGlobalPackageVersion(
  packagePath: string | null,
  deps: Required<Pick<VersionResolutionDeps, "readFileSyncImpl">>
): string | null {
  if (!packagePath) return null

  try {
    const raw = deps.readFileSyncImpl(packagePath, "utf-8")
    const parsed = JSON.parse(raw) as { version?: string }
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null
  } catch {
    return null
  }
}

function resolveDeps(overrides: VersionResolutionDeps = {}) {
  return {
    env: overrides.env ?? process.env,
    platform: overrides.platform ?? process.platform,
    execFileSyncImpl: overrides.execFileSyncImpl ?? execFileSync,
    existsSyncImpl: overrides.existsSyncImpl ?? existsSync,
    readFileSyncImpl: overrides.readFileSyncImpl ?? readFileSync
  }
}

export function isInstalledClaudeRequired(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return parseBooleanFlag(env.CLAUDE_PROXY_REQUIRE_INSTALLED_CLAUDE)
}

export function inspectInstalledClaudeCode(
  overrides: VersionResolutionDeps = {}
): InstalledClaudeCodeInfo {
  const deps = resolveDeps(overrides)
  const binaryPath = resolveClaudeBinaryPath(deps)
  const cliVersion = resolveCliVersion(deps)
  const packagePath = resolveGlobalPackagePath(deps)
  const packageVersion = resolveGlobalPackageVersion(packagePath, deps)

  return {
    binaryPath,
    cliVersion,
    packagePath,
    packageVersion
  }
}

export function resolveClaudeCodeMetadata(
  overrides: VersionResolutionDeps = {}
): ClaudeCodeMetadata {
  if (
    overrides.env === undefined &&
    overrides.platform === undefined &&
    overrides.execFileSyncImpl === undefined &&
    overrides.existsSyncImpl === undefined &&
    overrides.readFileSyncImpl === undefined &&
    cachedMetadata
  ) {
    return cachedMetadata
  }

  const deps = resolveDeps(overrides)
  const strictRequired = isInstalledClaudeRequired(deps.env)
  const explicitProxyVersion = deps.env.CLAUDE_PROXY_CLAUDE_CODE_VERSION?.trim()
  if (explicitProxyVersion) {
    const metadata: ClaudeCodeMetadata = {
      ...inspectInstalledClaudeCode(overrides),
      version: explicitProxyVersion,
      source: "env:CLAUDE_PROXY_CLAUDE_CODE_VERSION",
      strictRequired
    }
    if (overrides.env === undefined && !overrides.platform && !overrides.execFileSyncImpl && !overrides.existsSyncImpl && !overrides.readFileSyncImpl) {
      cachedMetadata = metadata
    }
    return metadata
  }

  const explicitCliVersion = deps.env.ANTHROPIC_CLI_VERSION?.trim()
  if (explicitCliVersion) {
    const metadata: ClaudeCodeMetadata = {
      ...inspectInstalledClaudeCode(overrides),
      version: explicitCliVersion,
      source: "env:ANTHROPIC_CLI_VERSION",
      strictRequired
    }
    if (overrides.env === undefined && !overrides.platform && !overrides.execFileSyncImpl && !overrides.existsSyncImpl && !overrides.readFileSyncImpl) {
      cachedMetadata = metadata
    }
    return metadata
  }

  const installed = inspectInstalledClaudeCode(overrides)

  let metadata: ClaudeCodeMetadata
  if (installed.cliVersion) {
    metadata = {
      ...installed,
      version: installed.cliVersion,
      source: "claude --version",
      strictRequired
    }
  } else if (installed.packageVersion) {
    metadata = {
      ...installed,
      version: installed.packageVersion,
      source: "global package.json",
      strictRequired
    }
  } else if (strictRequired) {
    throw new Error(
      "Claude Code version could not be resolved from the installed CLI or global package while " +
      "CLAUDE_PROXY_REQUIRE_INSTALLED_CLAUDE=1. Set CLAUDE_PROXY_CLAUDE_CODE_VERSION or install a working Claude CLI."
    )
  } else {
    metadata = {
      ...installed,
      version: config.ccVersion,
      source: "fallback",
      strictRequired
    }
  }

  if (
    overrides.env === undefined &&
    overrides.platform === undefined &&
    overrides.execFileSyncImpl === undefined &&
    overrides.existsSyncImpl === undefined &&
    overrides.readFileSyncImpl === undefined
  ) {
    cachedMetadata = metadata
  }

  return metadata
}

export function resolveClaudeCodeVersion(): string {
  return resolveClaudeCodeMetadata().version
}

export function resetResolvedClaudeCodeVersion(): void {
  cachedMetadata = null
}
