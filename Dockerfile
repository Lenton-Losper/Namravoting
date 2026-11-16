# NamRA Voting: production image. Build context is the repo root. Secrets and config come from environment variables at runtime, never from the image.
#
# BASE_PATH is the URL path the app is served under (NamRA hosting: /voting-app; the Cloudflare demo: empty = the root of the host).
# Vite bakes it into every asset URL, so it is a BUILD argument, and the same value is set at runtime (the server refuses to start if they differ).
#   docker build --build-arg BASE_PATH=/voting-app -t namra-voting .

# ---- build: compile the server and the client ----
FROM node:22-bookworm-slim AS build
ARG BASE_PATH=
ENV BASE_PATH=${BASE_PATH}
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
ARG BASE_PATH=
ENV NODE_ENV=production PORT=8080 BASE_PATH=${BASE_PATH} UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
COPY server/package.json server/package.json
COPY server/migrations server/migrations
# server/dist/app.js serves ../../client/dist, i.e. /app/client/dist; server/dist/migrate.js reads ../migrations
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 8080
# 200 only when the app is up AND the database answers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+(process.env.BASE_PATH||'')+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
