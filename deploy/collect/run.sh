#!/usr/bin/env bash
# One collection run on a collect VM (brain/tasks/world-model-data.md → "Infrastructure"), from a checkout of this
# repo: work through the seed queue in rounds of SERVERS seeds (one Paper server and one collector per seed; each
# collector stops when its seed has its share of COLLECT_TARGET_STEPS), copy episodes to the bucket every 10 minutes
# and at the end, then power the VM off. Needs Docker and gcloud (GCE images have gcloud; the VM's service account
# needs write access to the bucket).
#   sudo COLLECT_BUCKET=gs://jeeve-worlddata/v1 MINECRAFT_EULA=true bash deploy/collect/run.sh
#   smoke: … SERVERS=1 BOTS=8 SEEDS=123,456 COLLECT_TARGET_STEPS=36000 POWEROFF=0 bash deploy/collect/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${COLLECT_BUCKET:?the gs:// path to copy episodes to}"
SERVERS=${SERVERS:-8} BOTS=${BOTS:-8} COLLECT_TARGET_STEPS=${COLLECT_TARGET_STEPS:-5000000}

docker build -t jeeve .
mkdir -p episodes && chown 1000:1000 episodes
# The queue: SEEDS, or 60 random ones; every sixth is held out unless COLLECT_HELDOUT names them. Kept in episodes/
# (and so the bucket): a re-run works through the same queue, and collectors skip the seeds already done.
[ -n "${SEEDS:-}" ] && tr , '\n' <<< "$SEEDS" > episodes/seeds.txt
[ -s episodes/seeds.txt ] || for _ in $(seq 60); do od -An -N4 -tu4 /dev/urandom | tr -d ' '; done > episodes/seeds.txt
mapfile -t seeds < episodes/seeds.txt
COLLECT_HELDOUT=${COLLECT_HELDOUT:-$(awk 'NR % 6 == 0' episodes/seeds.txt | paste -sd, -)}
COLLECT_SEED_STEPS=$((COLLECT_TARGET_STEPS / ${#seeds[@]}))
export MINECRAFT_EULA COLLECT_HELDOUT COLLECT_SEED_STEPS
echo "${#seeds[@]} seeds, $COLLECT_SEED_STEPS steps each; held out: $COLLECT_HELDOUT"

copy() { gcloud storage rsync -r --exclude='.*\.tmp$' episodes "$COLLECT_BUCKET"; }
( while sleep 600; do copy || true; done ) &
# Each round restarts the Paper containers with the round's SEED and LEVEL (a new world in the same volume):
# simpler than multiworld plugins, and a server's queue position is just its index in the round.
compose() { docker compose -f compose.collect.json "$@"; }
for ((i = 0; i < ${#seeds[@]}; i += SERVERS)); do
  round=$(IFS=,; echo "${seeds[*]:i:SERVERS}")
  echo "round $((i / SERVERS + 1)): $round"
  docker run --rm jeeve node collect/compose.ts "$BOTS" "$round" > compose.collect.json
  compose up -d --remove-orphans
  collectors=$(compose config --services | grep '^collector-')
  # shellcheck disable=SC2046,SC2086
  docker wait $(compose ps -aq $collectors) > /dev/null
  # shellcheck disable=SC2086
  compose logs --no-color $collectors >> collector.log
done
kill %1 || true
copy
gcloud storage cp collector.log "$COLLECT_BUCKET/logs/collector-$(date +%Y%m%dT%H%M%S).log"
compose down
[ "${POWEROFF:-1}" = 1 ] && shutdown -h now
