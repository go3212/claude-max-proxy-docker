FROM oven/bun:1

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY bin/ ./bin/
COPY src/ ./src/
COPY tsconfig.json ./

EXPOSE 3456

ENV CLAUDE_PROXY_HOST=0.0.0.0

# Mount credentials at runtime: -v ~/.claude:/root/.claude:ro
ENTRYPOINT ["bun", "run", "./bin/claude-proxy.ts"]
