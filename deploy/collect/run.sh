#!/usr/bin/env bash
# One collection run on a collect VM (brain/tasks/world-model-data.md → "Infrastructure"), from a checkout of this
# repo: generate the Compose file, run until the collector stops at its step target, copy episodes to the bucket
# every 10 minutes and at the end, then power the VM off. Needs Docker and gcloud (GCE images have gcloud; the VM's
# service account needs write access to the bucket).
#   sudo COLLECT_BUCKET=gs://jeeve-worlddata/v1 MINECRAFT_EULA=true SERVERS=1 BOTS=4 COLLECT_TARGET_STEPS=18000 bash deploy/collect/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${COLLECT_BUCKET:?the gs:// path to copy episodes to}"
export MINECRAFT_EULA COLLECT_TARGET_STEPS COLLECT_HELDOUT

docker build -t jeeve .
docker run --rm jeeve node collect/compose.ts "${SERVERS:-1}" "${BOTS:-4}" "${SEEDS:-}" > compose.collect.json
mkdir -p episodes && chown 1000:1000 episodes
docker compose -f compose.collect.json up -d

copy() { gcloud storage rsync -r --exclude='.*\.tmp$' episodes "$COLLECT_BUCKET"; }
( while sleep 600; do copy || true; done ) &
docker wait "$(docker compose -f compose.collect.json ps -q collector)"
kill %1 || true
copy
docker compose -f compose.collect.json logs collector > collector.log
gcloud storage cp collector.log "$COLLECT_BUCKET/logs/collector-$(date +%Y%m%dT%H%M%S).log"
docker compose -f compose.collect.json down
[ "${POWEROFF:-1}" = 1 ] && shutdown -h now
