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

compose() { docker compose -f compose.collect.json "$@"; }
copy() { gcloud storage rsync -r --exclude='.*\.tmp$' episodes "$COLLECT_BUCKET"; }
# However the run ends: the last copy, the log, and the VM off, so a failed round never leaves it billing.
finish() {
  kill %1 || true
  copy || true
  gcloud storage cp collector.log "$COLLECT_BUCKET/logs/collector-$(date +%Y%m%dT%H%M%S).log" || true
  compose down || true
  [ "${POWEROFF:-1}" != 1 ] || shutdown -h now
}
trap finish EXIT

docker build -t jeeve .
mkdir -p episodes && chown 1000:1000 episodes
# The queue: SEEDS, or 60 random ones; every sixth is held out unless COLLECT_HELDOUT names them. Kept in episodes/
# (and so the bucket): a re-run works through the same queue.
[ -n "${SEEDS:-}" ] && tr , '\n' <<< "$SEEDS" > episodes/seeds.txt
[ -s episodes/seeds.txt ] || for _ in $(seq 60); do od -An -N4 -tu4 /dev/urandom | tr -d ' '; done > episodes/seeds.txt
mapfile -t seeds < episodes/seeds.txt
COLLECT_HELDOUT=${COLLECT_HELDOUT:-$(awk 'NR % 6 == 0' episodes/seeds.txt | paste -sd, -)}
COLLECT_SEED_STEPS=$((COLLECT_TARGET_STEPS / ${#seeds[@]}))
export MINECRAFT_EULA COLLECT_HELDOUT COLLECT_SEED_STEPS
echo "${#seeds[@]} seeds, $COLLECT_SEED_STEPS steps each; held out: $COLLECT_HELDOUT"

( while sleep 600; do copy || true; done ) &
# A seed is done once its coverage.json has its steps.
done_() { local n; n=$(grep -ohs '"steps": [0-9]*' episodes/*/"$1"/coverage.json | grep -o '[0-9]*$'); [ "${n:-0}" -ge "$COLLECT_SEED_STEPS" ]; }
# Each round restarts the Paper containers with the round's SEED and LEVEL (a new world in the same volume): simpler
# than multiworld plugins. A second pass reruns the seeds a crashed or timed-out collector left short, from their
# saved starts and steps (on their kept world when they get the same server).
for pass in 1 2; do
  queue=()
  for s in "${seeds[@]}"; do done_ "$s" || queue+=("$s"); done
  for ((i = 0; i < ${#queue[@]}; i += SERVERS)); do
    round=$(IFS=,; echo "${queue[*]:i:SERVERS}")
    echo "pass $pass, round $((i / SERVERS + 1)): $round" | tee -a collector.log
    docker run --rm jeeve node collect/compose.ts "$BOTS" "$round" > compose.collect.json
    if ! compose up -d --remove-orphans; then echo "round failed to start" | tee -a collector.log; compose down || true; continue; fi
    collectors=$(compose config --services | grep '^collector-')
    # A round that hangs (a stuck RCON call, a server that never comes back) is stopped; its seeds keep their steps.
    # shellcheck disable=SC2046,SC2086
    timeout "${ROUND_TIMEOUT:-2h}" docker wait $(compose ps -aq $collectors) | paste -sd' ' | sed 's/^/collector exit codes: /' >> collector.log ||
      { echo "round timed out" >> collector.log; compose stop -t 120 $collectors; }
    # shellcheck disable=SC2086
    compose logs --no-color $collectors >> collector.log
  done
done
