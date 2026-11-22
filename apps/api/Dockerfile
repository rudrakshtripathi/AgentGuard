FROM node:24.11.1-alpine3.22@sha256:2867d550cf9d8bb50059a0fff528741f11a84d985c732e60e19e8e75c7239c43 AS dependencies
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/demo-agent/package.json apps/demo-agent/package.json
COPY packages/agentguard-sdk/package.json packages/agentguard-sdk/package.json
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build -w @agentguard/api && npm prune --omit=dev

# Keep OPA 1.21.1 in sync with scripts/lib/opa.mjs; verify the bundled binary by SHA-256.
FROM openpolicyagent/opa:1.21.1-static@sha256:4675ab04ad1627f74741d2d9c5142698c79e18b7b09f192587d31d6dba20838e AS opa-source
FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f AS opa
COPY --from=opa-source /opa /opa
RUN echo "7e3a381217a13a1e4ae6b29c064e9651537fc2d2cec87c0038e0f739506bd676  /opa" | sha256sum -c - \
    && chmod 0755 /opa

FROM node:24.11.1-alpine3.22@sha256:2867d550cf9d8bb50059a0fff528741f11a84d985c732e60e19e8e75c7239c43 AS runtime
ENV NODE_ENV=production
WORKDIR /repo
RUN addgroup -S agentguard && adduser -S -G agentguard agentguard
COPY --from=build --chown=agentguard:agentguard /repo/node_modules ./node_modules
COPY --from=build --chown=agentguard:agentguard /repo/package.json ./package.json
COPY --from=build --chown=agentguard:agentguard /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=agentguard:agentguard /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=agentguard:agentguard /repo/apps/api/models ./apps/api/models
COPY --from=build --chown=agentguard:agentguard /repo/db/migrations ./db/migrations
COPY --from=build --chown=agentguard:agentguard /repo/policies ./policies
COPY --from=opa --chown=agentguard:agentguard /opa /usr/local/bin/opa
COPY --chown=agentguard:agentguard apps/api/docker-entrypoint.mjs ./apps/api/docker-entrypoint.mjs
COPY --chown=agentguard:agentguard apps/api/docker-seed.mjs ./apps/api/docker-seed.mjs
USER agentguard
EXPOSE 4000
ENTRYPOINT ["node", "apps/api/docker-entrypoint.mjs"]
