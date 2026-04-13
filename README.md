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

Replay a redacted OpenCode request captured by the proxy:

```bash
bun run validate:capture -- ./captures/latest-request.json
```

This replays the sanitized request shape through the current checked-out proxy code and exits non-zero if Anthropic still classifies it as third-party extra usage.

For the closest Claude Code parity, first capture one real official Claude request and keep its raw capture available to the proxy:

```bash
bun run capture:official-claude -- -p "Reply with exactly OK."
```

When `./captures/official-claude/latest-raw.json` exists, the proxy uses it as the source of truth for the outbound Claude scaffold: `?beta=true`, `sdk-cli` user-agent shape, `x-stainless-*` headers, system scaffold, and other top-level Claude Code request fields.

If you want to keep the official Claude headers/body envelope but reduce `system[]` to Hermes-style core entries, set:

```bash
CLAUDE_PROXY_SYSTEM_MODE=hermes-minimal
```

`official` remains the default. `hermes-minimal` is experimental and drops unsupported non-Claude tools instead of retrying them.

Capture a real outbound request from the installed official Claude CLI:

```bash
bun run capture:official-claude -- -p "Reply with exactly OK."
```

This runs your installed `claude` binary under a Node `--require` hook and writes:

- `./captures/official-claude/latest-raw.json`
- `./captures/official-claude/latest-redacted.json`

The raw file keeps the exact official request locally for diffing. The redacted file preserves request shape, headers, betas, tool names, and schema structure while stripping auth values and free-form prompt text.

Diff the latest official redacted capture against the proxy's latest capture:

```bash
bun run diff:official-vs-proxy -- ./captures/official-claude/latest-redacted.json ./captures/latest-request.json
```

The diff normalizes dynamic request ids and focuses on meaningful parity differences such as user-agent, beta set, top-level body fields, system/message shape, and tool schema structure.

Inspect which installed Claude Code identity the proxy will use:

```bash
bun run inspect:claude-code
```

## Docker

```bash
docker compose up --build
```

The bundled `docker-compose.yml` enables debug logging and writes the latest redacted incoming request to `./captures/latest-request.json`.
It also requires a resolvable installed Claude Code identity instead of silently falling back to the pinned vendored version.

Useful commands:

```bash
docker compose logs -f claude-proxy
bun run inspect:claude-code
bun run capture:official-claude -- -p "Reply with exactly OK."
bun run validate:capture -- ./captures/latest-request.json
docker compose run --rm --entrypoint bun claude-proxy run ./bin/capture-official-claude.ts -- -p "Reply with exactly OK."
bun run diff:official-vs-proxy -- ./captures/official-claude/latest-redacted.json ./captures/latest-request.json
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Proxy server port |
| `CLAUDE_PROXY_HOST` | `127.0.0.1` | Proxy server host |
| `CLAUDE_PROXY_DEBUG` | `0` | Enables proxy debug logs to stdout; `OPENCODE_CLAUDE_PROVIDER_DEBUG` remains a compatibility alias |
| `CLAUDE_PROXY_CAPTURE_PATH` | unset | Writes the latest redacted incoming request fixture to this path |
| `CLAUDE_PROXY_REQUIRE_INSTALLED_CLAUDE` | `false` | Fails startup if the proxy cannot resolve the installed Claude Code identity from the CLI or global package |
| `CLAUDE_PROXY_OFFICIAL_CAPTURE_RAW_PATH` | auto | Optional raw official Claude capture file used as the source of truth for the outbound Claude scaffold |
| `CLAUDE_PROXY_METADATA_USER_ID` | unset | Optional explicit override for `metadata.user_id` in the outbound Claude scaffold |
| `CLAUDE_PROXY_SYSTEM_MODE` | `official` | `official` keeps the captured Claude scaffold; `hermes-minimal` keeps official headers/betas but reduces `system[]` to billing + identity and drops unsupported tools |
| `CLAUDE_OFFICIAL_CAPTURE_DIR` | auto | Base directory for official Claude raw/redacted capture files |
| `CLAUDE_OFFICIAL_CAPTURE_RAW_PATH` | auto | Override the exact raw official Claude capture file path |
| `CLAUDE_OFFICIAL_CAPTURE_REDACTED_PATH` | auto | Override the exact redacted official Claude capture file path |
| `CLAUDE_PROXY_CREDENTIALS_PATH` | `~/.claude/.credentials.json` | Override the Claude credentials file path |
| `CLAUDE_PROXY_CLAUDE_CODE_VERSION` | auto-detected | Highest-priority Claude Code version override |
| `ANTHROPIC_CLI_VERSION` | auto-detected | Claude Code version for billing header and user-agent |
| `ANTHROPIC_USER_AGENT` | `claude-cli/{version} (external, sdk-cli)` | Full user-agent override |
| `ANTHROPIC_BETA_FLAGS` | built-in Claude Code beta set | Comma-separated beta override |
| `ANTHROPIC_ENABLE_1M_CONTEXT` | `false` | Adds the 1M context beta for supported Sonnet/Opus models |
| `CLAUDE_CODE_ENTRYPOINT` | `cli` | Billing header entrypoint value |

## How It Works

1. **OpenCode** sends a request to `http://127.0.0.1:3456/v1/messages`
2. **Proxy** reads or refreshes your OAuth token from `~/.claude/.credentials.json`
3. **Proxy** rewrites the request body and headers to match Claude Code OAuth expectations
4. **Proxy** forwards the transformed request to `api.anthropic.com`
5. **Proxy** pipes the response directly back to OpenCode

When `CLAUDE_PROXY_CAPTURE_PATH` is set, the proxy also writes a redacted copy of the original incoming request plus transform metadata so the exact OpenCode shape can be replayed locally.

When `capture:official-claude` is used, the installed `/usr/bin/claude` process is launched under a Node runtime hook that records only outbound `https://api.anthropic.com/v1/messages` traffic. That produces a raw local capture and a shareable redacted copy for parity diffing against the proxy.

If a raw official capture is available, the proxy uses it at runtime as the scaffold for official Claude Code request structure and layers the Hermes-style billing/reminder transform on top.

`CLAUDE_PROXY_SYSTEM_MODE=official` keeps that scaffolded `system[]` layout. `CLAUDE_PROXY_SYSTEM_MODE=hermes-minimal` keeps the official outer request shape but reduces `system[]` to the billing header plus Claude Code identity, moves extra system text into the first user message as `<system-reminder>`, normalizes supported tool names, and drops unsupported tools up front.

The server vendors the core `opencode-claude-auth` logic for signing, beta selection, request transforms, and token refresh, but exposes it as a normal local HTTP proxy instead of an OpenCode plugin.

## FAQ

### Why do I need `ANTHROPIC_API_KEY=dummy`?

OpenCode requires an API key to be set, but the proxy ignores it. Authentication is handled via your Claude CLI OAuth tokens. Any non-empty string works.

### Does this work with other tools besides OpenCode?

Yes. Any tool that speaks the Anthropic Messages API can point `ANTHROPIC_BASE_URL` at `http://127.0.0.1:3456`.

### What about rate limits?

Your Claude Max subscription keeps its normal usage limits. This proxy does not add extra limits.

### Do I need Claude CLI installed after login?

Usually only for the initial `claude login`, but keeping it installed is useful because the proxy can detect the installed Claude Code version and may fall back to the CLI if an OAuth refresh fails.

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

### OpenCode still gets the extra-usage / third-party apps message

If you are testing with Docker Compose, inspect the live logs and the latest redacted capture:

```bash
docker compose logs -f claude-proxy
bun run inspect:claude-code
cat ./captures/latest-request.json
bun run validate:capture -- ./captures/latest-request.json
```

If `validate:live` succeeds but `validate:capture` fails, the remaining issue is in the real OpenCode request shape rather than the basic proxy credentials path.

### How do I compare the proxy with real Claude Code?

Capture one request from the installed Claude CLI and diff it against the latest proxy capture:

```bash
bun run capture:official-claude -- -p "Reply with exactly OK."
bun run diff:official-vs-proxy -- ./captures/official-claude/latest-redacted.json ./captures/latest-request.json
```

If the diff reports a mismatch, that output is the next source of truth for header/body parity changes.

### OpenCode still gets the extra-usage / third-party apps message after the latest parity changes

Make sure the proxy is actually using a real official raw Claude capture:

```bash
bun run capture:official-claude -- -p "Reply with exactly OK."
docker compose logs -f claude-proxy
```

The debug logs should show `scaffoldSource: "raw-capture"` instead of `fallback`. If the proxy is still on fallback, it is missing the official Claude scaffold source it now depends on for closest parity.

### Docker exits at startup with an installed-Claude error

Run:

```bash
bun run inspect:claude-code
```

If strict mode is enabled, the proxy will now fail fast instead of silently using the vendored fallback version when it cannot resolve the installed Claude Code binary or global package version.

## License

MIT
