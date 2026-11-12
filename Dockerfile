# NamRA Voting: production image (demo deployment on Cloudflare Containers).
# Build context is the repo root. Secrets and config come from environment variables at runtime, never from the image.

# ---- build: compile the server and the client ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY server server
COPY client client
RUN npm run build

# ---- prod deps only (native modules such as sharp are fetched for this Linux image) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace server --include-workspace-root=false --no-audit --no-fund

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
COPY server/package.json server/package.json
# server/dist/app.js serves ../../client/dist, i.e. /app/client/dist
USER node
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
