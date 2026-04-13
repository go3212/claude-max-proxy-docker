import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { claudeLog } from "../logger"

const CREDENTIAL_CACHE_TTL_MS = 30_000
const REFRESH_WINDOW_MS = 60_000
const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

let cachedCredentials: ClaudeCredentials | null = null
let cachedAt = 0

export interface OAuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes?: string[]
  subscriptionType?: string
  rateLimitTier?: string
}

export interface ClaudeCredentials {
  claudeAiOauth: OAuthTokens
  organizationUuid?: string
}

interface OAuthRefreshResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

export function getCredentialsPath(): string {
  return (
    process.env.CLAUDE_PROXY_CREDENTIALS_PATH ??
    join(homedir(), ".claude", ".credentials.json")
  )
}

export function readCredentialsFile(path = getCredentialsPath()): ClaudeCredentials {
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch (error) {
    throw new Error(
      `Failed to load credentials from ${path}. Run 'claude login' first.\n` +
      (error instanceof Error ? error.message : String(error))
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Failed to parse credentials from ${path}.\n` +
      (error instanceof Error ? error.message : String(error))
    )
  }

  const credentials = parsed as Partial<ClaudeCredentials>
  const oauth = credentials.claudeAiOauth as Partial<OAuthTokens> | undefined
  if (
    !oauth?.accessToken ||
    !oauth.refreshToken ||
    typeof oauth.expiresAt !== "number"
  ) {
    throw new Error(`Credentials file at ${path} is missing Claude OAuth tokens.`)
  }

  return credentials as ClaudeCredentials
}

export function writeCredentialsFile(
  credentials: ClaudeCredentials,
  path = getCredentialsPath()
): void {
  const directory = dirname(path)
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  writeFileSync(path, JSON.stringify(credentials), {
    encoding: "utf-8",
    mode: 0o600
  })

  if (process.platform !== "win32") {
    chmodSync(path, 0o600)
  }
}

export function parseOAuthResponse(
  raw: string,
  current: ClaudeCredentials,
  now = Date.now()
): ClaudeCredentials | null {
  let data: OAuthRefreshResponse
  try {
    data = JSON.parse(raw) as OAuthRefreshResponse
  } catch {
    return null
  }

  if (!data.access_token) return null

  return {
    ...current,
    claudeAiOauth: {
      ...current.claudeAiOauth,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? current.claudeAiOauth.refreshToken,
      expiresAt: now + (data.expires_in ?? 36_000) * 1000
    }
  }
}

async function refreshViaOAuth(
  credentials: ClaudeCredentials
): Promise<ClaudeCredentials | null> {
  claudeLog("auth.refresh.oauth.start")

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: credentials.claudeAiOauth.refreshToken
    })

    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    })

    const raw = await response.text()
    if (!response.ok) {
      claudeLog("auth.refresh.oauth.failed", { status: response.status, body: raw })
      return null
    }

    const refreshed = parseOAuthResponse(raw, credentials)
    if (!refreshed) {
      claudeLog("auth.refresh.oauth.failed", { reason: "missing access_token" })
      return null
    }

    claudeLog("auth.refresh.oauth.success", {
      expiresAt: refreshed.claudeAiOauth.expiresAt
    })
    return refreshed
  } catch (error) {
    claudeLog("auth.refresh.oauth.failed", {
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

function refreshViaCli(): boolean {
  claudeLog("auth.refresh.cli.start")

  try {
    execFileSync("claude", ["-p", ".", "--model", "haiku"], {
      timeout: 60_000,
      encoding: "utf-8",
      env: { ...process.env, TERM: "dumb" },
      stdio: ["ignore", "ignore", "ignore"],
      cwd: tmpdir()
    })
    claudeLog("auth.refresh.cli.success")
    return true
  } catch (error) {
    claudeLog("auth.refresh.cli.failed", {
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

async function refreshIfNeeded(credentials: ClaudeCredentials): Promise<ClaudeCredentials> {
  if (credentials.claudeAiOauth.expiresAt > Date.now() + REFRESH_WINDOW_MS) {
    return credentials
  }

  const refreshed = await refreshViaOAuth(credentials)
  if (refreshed) {
    writeCredentialsFile(refreshed)
    return refreshed
  }

  if (refreshViaCli()) {
    const reloaded = readCredentialsFile()
    if (reloaded.claudeAiOauth.expiresAt > Date.now() + REFRESH_WINDOW_MS) {
      return reloaded
    }
  }

  throw new Error("Claude credentials are expired and could not be refreshed. Run 'claude login' again.")
}

export async function getValidCredentials(): Promise<ClaudeCredentials> {
  const now = Date.now()
  if (
    cachedCredentials &&
    now - cachedAt < CREDENTIAL_CACHE_TTL_MS &&
    cachedCredentials.claudeAiOauth.expiresAt > now + REFRESH_WINDOW_MS
  ) {
    return cachedCredentials
  }

  let credentials = readCredentialsFile()
  credentials = await refreshIfNeeded(credentials)

  cachedCredentials = credentials
  cachedAt = now
  return credentials
}

export function resetCredentialCache(): void {
  cachedCredentials = null
  cachedAt = 0
}
