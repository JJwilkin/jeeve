# One Jeeve per container, plus the web relay (docker-compose.yml) and the world-model collector (collect/). Secrets come from the env file at run time, never the image.
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /app
COPY package.json package-lock.json ./
# onnxruntime (the world model, src/wm.ts) runs on the CPU: no CUDA download, and only the Linux binaries.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev && npm cache clean --force \
  && rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin node_modules/onnxruntime-node/bin/napi-v6/win32
COPY src src
COPY web web
COPY collect collect
# The world model's files, fetched by deploy/setup.sh (wm/README.md); without them the model is off.
COPY wm wm
# traces/ is a named volume; owning it here lets a fresh volume start out writable by node.
# modules/ is bind-mounted from the checkout (docker-compose.yml), so it isn't baked in.
RUN mkdir traces && chown node:node traces
USER node
CMD ["node", "src/main.ts"]
