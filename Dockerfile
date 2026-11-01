# One Jeeve per container, plus the web relay (docker-compose.yml). Secrets come from the env file at run time, never the image.
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src src
COPY web web
# traces/ is a named volume; owning it here lets a fresh volume start out writable by node.
# modules/ is bind-mounted from the checkout (docker-compose.yml), so it isn't baked in.
RUN mkdir traces && chown node:node traces
USER node
CMD ["node", "src/main.ts"]
