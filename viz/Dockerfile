# The spectate page's static build, served by Caddy (Caddyfile, docker-compose.yml).
# amd64 even on Apple Silicon: the build only makes static files, and gl (a prismarine-viewer dev dep) has no
# linux-arm64 prebuild. Its amd64 prebuild loads the X11 and GL libraries below.
FROM --platform=linux/amd64 node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
WORKDIR /viz
# git: prismarine-viewer and node-canvas-webgl are pinned to GitHub commits.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libx11-6 libxi6 libxext6 libgl1 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# prismarine-viewer's prepare script installs its dev deps and renders its texture atlas with canvas, so install
# scripts must run. Puppeteer is one of those dev deps; its Chrome isn't needed.
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci
COPY . .
RUN npm run build
# The 158 MB mesher worker and 13 MB of block states, compressed once here rather than per viewer by Caddy.
RUN find dist \( -name '*.js' -o -name '*.json' \) -size +1M -exec gzip -k9 {} +

FROM caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5
COPY --from=build /viz/dist /srv
