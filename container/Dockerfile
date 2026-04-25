# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# ---- Build-time arguments for pinned CLI versions ----------------------------
# Pin versions to reduce supply-chain blast radius. A malicious release of any
# of these wouldn't be picked up at next container rebuild without deliberate
# ARG bump. Adopted from upstream nanoclaw v2.
ARG CLAUDE_CODE_VERSION=2.1.116
ARG AGENT_BROWSER_VERSION=latest
ARG TSX_VERSION=4.17.0

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    jq \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Wrap crashpad handler to supply the missing --database flag.
# Chromium's crashpad subprocess fails with "chrome_crashpad_handler: --database
# is required" inside containers, causing SIGTRAP. This wrapper creates the db
# directory and passes --database to the real handler so it stays alive.
RUN mv /usr/lib/chromium/chrome_crashpad_handler /usr/lib/chromium/chrome_crashpad_handler.real \
    && printf '#!/bin/sh\nmkdir -p /tmp/crashpad-db 2>/dev/null\nexec /usr/lib/chromium/chrome_crashpad_handler.real --database=/tmp/crashpad-db "$@"\n' \
       > /usr/lib/chromium/chrome_crashpad_handler \
    && chmod +x /usr/lib/chromium/chrome_crashpad_handler

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION} @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY container/agent-runner/package*.json ./

# Install dependencies (devDeps pruned below; kept here for npm install compatibility)
RUN npm install

# Source code is mounted RO at runtime (/app/src → container/agent-runner/src).
# No COPY or tsc build needed — tsx resolves from the mount at startup.

# Install tsx for fast TypeScript execution at startup
RUN npm install -g tsx@${TSX_VERSION}

# Remove dev dependencies from production image
RUN npm prune --omit=dev

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input /workspace/.claude/skills

# Create entrypoint script
# Secrets are passed via stdin JSON — agent-runner reads stdin directly
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\nif [ -f /workspace/env-dir/env ]; then\n  set -a\n  . /workspace/env-dir/env\n  set +a\nfi\ncd /app && exec tsx src/index.ts\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
