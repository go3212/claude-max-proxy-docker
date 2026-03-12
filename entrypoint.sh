#!/bin/bash
CREDS="/root/.claude/.credentials.json"

if [ ! -f "$CREDS" ]; then
  echo "============================================"
  echo " No credentials found."
  echo " Run: docker exec -it <container> claude login"
  echo "============================================"
  # Keep container alive waiting for login
  while [ ! -f "$CREDS" ]; do
    sleep 2
  done
  echo "Credentials detected! Starting proxy..."
fi

exec bun run ./bin/claude-proxy.ts
