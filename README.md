# opencode-claude-max-proxy

[![npm version](https://img.shields.io/npm/v/opencode-claude-max-proxy.svg)](https://www.npmjs.com/package/opencode-claude-max-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/rynfar/opencode-claude-max-proxy.svg)](https://github.com/rynfar/opencode-claude-max-proxy/stargazers)

Use your **Claude Max subscription** with OpenCode through a local proxy server that vendors the core auth and request-shaping logic from `opencode-claude-auth`.

## The Problem

Anthropic does not allow Claude Max subscribers to use their subscription directly with third-party tools like OpenCode. After the OAuth validation changes rolled out in April 2026, a plain Bearer-token passthrough was no longer enough for many Claude Code-style requests.

## The Solution

This proxy forwards Anthropic API requests using your Claude Code OAuth tokens and rewrites them to match the Claude Code OAuth format Anthropic now expects server-side:

```text
OpenCode -> Proxy (localhost:3456) -> api.anthropic.com -> Your Claude Max Subscription
```

It keeps the local HTTP proxy workflow, but applies the same core request transforms as `opencode-claude-auth`: billing header signing, Claude Code identity shaping, model-aware beta flags, and direct OAuth refresh with write-back to disk.

## Features

| Feature | Description |
|---------|-------------|
| **Zero API costs** | Uses your Claude Max subscription |
| **Full API support** | Prompt caching, extended thinking, vision, tool use, PDFs, structured outputs |
| **Streaming** | Native SSE streaming passthrough |
| **OAuth bypass parity** | Injects billing headers, Claude Code identity, and model-aware beta flags |
| **Auto token refresh** | Refreshes OAuth tokens directly and writes rotated tokens back to disk |
| **Version overrides** | Supports `ANTHROPIC_CLI_VERSION`, `ANTHROPIC_USER_AGENT`, and `ANTHROPIC_BETA_FLAGS` |

## Prerequisites

1. **Claude Max subscription** - [Subscribe here](https://claude.ai/settings/subscription)
2. **Claude CLI** authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude login
   ```
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

### Start the proxy

```bash
bun run proxy
```

### Run OpenCode

```bash
ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

Select any `anthropic/claude-*` model.

### One-liner

```bash
bun run proxy & ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

## Validation

Run the local regression suite:

```bash
bun test
```

Run a real in-process validation request against Anthropic with your local Claude credentials:

```bash
bun run validate:live
```

The live validator sends one small non-streaming request through the current checked-out proxy code and exits non-zero if Anthropic still classifies it as third-party extra usage. You can override its inputs with:

- `CLAUDE_PROXY_VALIDATE_MODEL`
- `CLAUDE_PROXY_VALIDATE_SYSTEM`
- `CLAUDE_PROXY_VALIDATE_PROMPT`

## Docker

```bash
docker build -t claude-max-proxy .
docker run -p 3456:3456 -v ~/.claude:/root/.claude claude-max-proxy
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Proxy server port |
| `CLAUDE_PROXY_HOST` | `127.0.0.1` | Proxy server host |
| `CLAUDE_PROXY_CREDENTIALS_PATH` | `~/.claude/.credentials.json` | Override the Claude credentials file path |
| `CLAUDE_PROXY_CLAUDE_CODE_VERSION` | auto-detected | Highest-priority Claude Code version override |
| `ANTHROPIC_CLI_VERSION` | auto-detected | Claude Code version for billing header and user-agent |
| `ANTHROPIC_USER_AGENT` | `claude-cli/{version} (external, cli)` | Full user-agent override |
| `ANTHROPIC_BETA_FLAGS` | built-in Claude Code beta set | Comma-separated beta override |
| `ANTHROPIC_ENABLE_1M_CONTEXT` | `false` | Adds the 1M context beta for supported Sonnet/Opus models |
| `CLAUDE_CODE_ENTRYPOINT` | `cli` | Billing header entrypoint value |

## How It Works

1. **OpenCode** sends a request to `http://127.0.0.1:3456/v1/messages`
2. **Proxy** reads or refreshes your OAuth token from `~/.claude/.credentials.json`
3. **Proxy** rewrites the request body and headers to match Claude Code OAuth expectations
4. **Proxy** forwards the transformed request to `api.anthropic.com`
5. **Proxy** pipes the response directly back to OpenCode

The server vendors the core `opencode-claude-auth` logic for signing, beta selection, request transforms, and token refresh, but exposes it as a normal local HTTP proxy instead of an OpenCode plugin.

## FAQ

### Why do I need `ANTHROPIC_API_KEY=dummy`?

OpenCode requires an API key to be set, but the proxy ignores it. Authentication is handled via your Claude CLI OAuth tokens. Any non-empty string works.

### Does this work with other tools besides OpenCode?

Yes. Any tool that speaks the Anthropic Messages API can point `ANTHROPIC_BASE_URL` at `http://127.0.0.1:3456`.

### What about rate limits?

Your Claude Max subscription keeps its normal usage limits. This proxy does not add extra limits.

### Do I need Claude CLI installed after login?

Usually only for the initial `claude login`, but keeping it installed is useful because the proxy can detect the local Claude Code version and may fall back to the CLI if an OAuth refresh fails.

## Troubleshooting

### "Failed to load credentials"

Run `claude login` to authenticate with the Claude CLI.

### "Claude credentials are expired and could not be refreshed"

Run `claude login` again. If you are using Docker, make sure the mounted `~/.claude` directory is writable when token rotation needs to be written back.

### "Connection refused"

Make sure the proxy is running:

```bash
bun run proxy
```

## License

MIT
