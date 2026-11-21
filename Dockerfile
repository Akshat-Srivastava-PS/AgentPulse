# Production Dockerfile for AgentPulse Oracle
FROM node:22-alpine AS runtime

WORKDIR /app

# The app runs as the non-root node user but must be able to create its
# SQLite database in /app — make the workdir writable by that user.
RUN chown node:node /app

# Ensure non-root user
USER node

# Copy application files with proper ownership
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/agentpulse.sqlite

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/v1/metrics').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
