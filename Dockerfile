FROM oven/bun:1

WORKDIR /app

# Install Node.js and Claude CLI for headless login
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install dependencies first (layer caching)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source
COPY bin/ ./bin/
COPY src/ ./src/
COPY tsconfig.json ./

EXPOSE 3456

ENV CLAUDE_PROXY_HOST=0.0.0.0

ENTRYPOINT ["bun", "run", "./bin/claude-proxy.ts"]
