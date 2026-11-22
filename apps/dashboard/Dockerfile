FROM node:24.11.1-alpine3.22@sha256:2867d550cf9d8bb50059a0fff528741f11a84d985c732e60e19e8e75c7239c43 AS dependencies
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/demo-agent/package.json apps/demo-agent/package.json
RUN npm ci

FROM dependencies AS build
COPY . .
ARG API_URL=http://api:4000
ENV API_URL=$API_URL NEXT_STANDALONE=1
RUN npm run build -w @agentguard/dashboard

FROM node:24.11.1-alpine3.22@sha256:2867d550cf9d8bb50059a0fff528741f11a84d985c732e60e19e8e75c7239c43 AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /repo
RUN addgroup -S dashboard && adduser -S -G dashboard dashboard
COPY --from=build --chown=dashboard:dashboard /repo/apps/dashboard/.next/standalone ./
COPY --from=build --chown=dashboard:dashboard /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
USER dashboard
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
