# opencode-claude-max-proxy

[![npm version](https://img.shields.io/npm/v/opencode-claude-max-proxy.svg)](https://www.npmjs.com/package/opencode-claude-max-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/rynfar/opencode-claude-max-proxy.svg)](https://github.com/rynfar/opencode-claude-max-proxy/stargazers)

Use your **Claude Max subscription** with OpenCode — with **full API feature support**.

## The Problem

Anthropic doesn't allow Claude Max subscribers to use their subscription with third-party tools like OpenCode. If you want to use Claude in OpenCode, you have to pay for API access separately - even though you're already paying for "unlimited" Claude.

## The Solution

This proxy transparently forwards Anthropic API requests using your Claude Max OAuth tokens:

```
OpenCode → Proxy (localhost:3456) → api.anthropic.com → Your Claude Max Subscription
```

Requests are passed through **as-is** — no transformation, no message flattening. This means every Anthropic API feature works automatically.

**Your Max subscription. Direct API passthrough. Zero additional cost.**

## Features

| Feature | Description |
|---------|-------------|
| **Zero API costs** | Uses your Claude Max subscription |
| **Full API support** | Prompt caching, extended thinking, vision, tool use, PDFs, structured outputs |
| **Streaming** | Native SSE streaming passthrough |
| **Auto token refresh** | OAuth tokens are refreshed automatically when expired |
| **Future-proof** | New API features work immediately — nothing to update |

## Prerequisites

1. **Claude Max subscription** - [Subscribe here](https://claude.ai/settings/subscription)

2. **Claude CLI** authenticated (one-time setup):
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude login
   ```
   You only need to run `claude login` once. The proxy reads the saved credentials directly — Claude CLI doesn't need to stay installed.

3. **Bun** runtime:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

## Installation

```bash
git clone https://github.com/rynfar/opencode-claude-max-proxy
cd opencode-claude-max-proxy
bun install
```

## Usage

### Start the Proxy

```bash
bun run proxy
```

### Run OpenCode

```bash
ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

Select any `anthropic/claude-*` model (opus, sonnet, haiku).

### One-liner

```bash
bun run proxy & ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

## Docker

```bash
docker build -t claude-max-proxy .
docker run -p 3456:3456 -v ~/.claude:/root/.claude:ro claude-max-proxy
```

## Auto-start on macOS

Set up the proxy to run automatically on login:

```bash
cat > ~/Library/LaunchAgents/com.claude-max-proxy.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-max-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which bun)</string>
        <string>run</string>
        <string>proxy</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(pwd)</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.claude-max-proxy.plist
```

Then add an alias to `~/.zshrc`:

```bash
echo "alias oc='ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode'" >> ~/.zshrc
source ~/.zshrc
```

Now just run `oc` to start OpenCode with Claude Max.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CLAUDE_PROXY_PORT` | 3456 | Proxy server port |
| `CLAUDE_PROXY_HOST` | 127.0.0.1 | Proxy server host |

## How It Works

1. **OpenCode** sends a request to `http://127.0.0.1:3456/v1/messages`
2. **Proxy** reads your OAuth token from `~/.claude/.credentials.json`
3. **Proxy** forwards the request as-is to `api.anthropic.com` with your token
4. **Anthropic** processes the request using your Max subscription
5. **Proxy** pipes the response directly back to OpenCode

The proxy is ~80 lines of TypeScript. No message transformation, no SDK dependency, just transparent forwarding.

## FAQ

### Why do I need `ANTHROPIC_API_KEY=dummy`?

OpenCode requires an API key to be set, but the proxy ignores it. Authentication is handled via your Claude CLI OAuth tokens. Any non-empty string works.

### Does this work with other tools besides OpenCode?

Yes! Any tool that uses the Anthropic API format can use this proxy. Just point `ANTHROPIC_BASE_URL` to `http://127.0.0.1:3456`.

### What about rate limits?

Your Claude Max subscription has its own usage limits. This proxy doesn't add any additional limits.

### Is my data sent anywhere else?

No. The proxy runs locally and forwards requests directly to `api.anthropic.com`.

### Do I need Claude CLI installed?

Only for the initial `claude login` to create the credentials file. After that, the proxy reads credentials directly — you can uninstall Claude CLI if you want.

## Troubleshooting

### "Failed to load credentials"

Run `claude login` to authenticate with the Claude CLI.

### "Token refresh failed"

Your refresh token may have expired. Run `claude login` again.

### "Connection refused"

Make sure the proxy is running: `bun run proxy`

## License

MIT
