FROM docker.io/oven/bun:1.3-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# Build stage (for any preprocessing if needed)
FROM base AS builder
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 ratatoskr && \
    adduser --system --uid 1001 ratatoskr

# Copy dependencies and source
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Create data directory
RUN mkdir -p /app/data && chown -R ratatoskr:ratatoskr /app/data

USER ratatoskr

# Default environment variables
ENV PORT=4151
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data

EXPOSE 4151

# Note: HEALTHCHECK is not supported by OCI format (Podman default)
# Use podman healthcheck commands or orchestration-level health checks instead
# Health endpoint available at: GET /health

CMD ["bun", "run", "src/index.ts"]
