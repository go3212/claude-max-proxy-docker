export interface ProxyConfig {
  port: number
  host: string
  debug: boolean
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: 3456,
  host: "127.0.0.1",
  debug: process.env.CLAUDE_PROXY_DEBUG === "1"
}

export interface OAuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType?: string
  rateLimitTier?: string
}

export interface ClaudeCredentials {
  claudeAiOauth: OAuthTokens
  organizationUuid?: string
}
