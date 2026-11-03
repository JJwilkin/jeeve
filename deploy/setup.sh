#!/usr/bin/env bash
# Sets up or updates the jeeve VM (Debian 12); safe to re-run. README.md has the whole deploy.
#   sudo bash setup.sh   (to join the tailnet, send TS_AUTHKEY=… down stdin first: deploy/README.md)
set -euo pipefail

# One function, so bash reads the whole script before running any of it: piped in over ssh, apt and curl | sh
# can't swallow the rest of stdin, and the git pull can't change the file under it.
main() {
  DIR=/opt/jeeve

  if ! command -v git >/dev/null || ! command -v cron >/dev/null; then
    apt-get update -q && apt-get install -yq git cron
  fi
  command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh # Docker's apt repo + the compose plugin

  # Only with a key: until then the VM serves the page and nothing outside the VPC reaches 25565.
  if [ -n "${TS_AUTHKEY:-}" ]; then
    command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
    tailscale status >/dev/null 2>&1 || tailscale up --authkey "$TS_AUTHKEY" --hostname jeeve
  fi

  [ -d "$DIR/.git" ] || git clone -q https://github.com/JJwilkin/jeeve.git "$DIR"
  git -C "$DIR" pull -q --ff-only

  if [ "$(stat -c %a "$DIR/.env" 2>/dev/null)" != 600 ]; then
    echo "Put the secrets in $DIR/.env with mode 600 first (deploy/README.md)." >&2
    exit 1
  fi

  # The world model on Jev's options (src/wm.ts), baked into the image. The VM's service account reads the bucket.
  # A failed fetch leaves the model off (or the last one fetched), not the deploy.
  # Fetched whole before it replaces anything, so the two graphs never come from different exports.
  wm=$(mktemp -d)
  if gcloud storage cp -q "gs://jeeve-worlddata/models/${WM_MODEL:-2m-v3}/*" "$wm/"; then cp "$wm"/* "$DIR/wm/"; else echo "world model ${WM_MODEL:-2m-v3} not fetched" >&2; fi
  rm -rf "$wm"

  chown -R 1000:1000 "$DIR/modules" # the image's node user writes what the Jeeves learn
  echo '17 4 * * * root find /var/lib/docker/volumes/jeeve_traces/_data -type f -mtime +7 -delete' > /etc/cron.d/jeeve-traces
  cd "$DIR" && docker compose up -d --build
}
main
