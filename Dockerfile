# One Jeeve per container (docker-compose.yml). Secrets come from the env file at run time, never the image.
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src src
# modules/ and traces/ are volumes; owning them here lets a fresh named volume start out writable by node.
COPY --chown=node:node modules modules
RUN mkdir traces && chown node:node traces
USER node
CMD ["node", "src/main.ts"]
