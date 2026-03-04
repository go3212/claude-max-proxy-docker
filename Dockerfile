FROM oven/bun:1

# Install Node.js (required by @anthropic-ai/claude-code)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

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

ENTRYPOINT ["bun", "run", "./bin/claude-proxy.ts"]
