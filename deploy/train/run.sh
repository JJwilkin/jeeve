#!/usr/bin/env bash
# The Tier 1 training run (brain/architecture/world-model-training.md) on one GPU VM, from a copy of this repo: the
# episodes from the bucket (same region, so no egress), shards, the tree baseline, the three sizes, ONNX export of
# the best by held-out Brier, all of it to the bucket, then power off. Needs gcloud (DLVM images have it) and the VM's
# service account with read on TRAIN_DATA and write on TRAIN_OUT.
#
# From the Mac, after Joshua's yes (GPU quota for one L4 in us-west1 is approved):
#   g() { gcloud --configuration jeeve --quiet "$@"; }
#   # a Deep Learning VM image with NVIDIA driver 580+ (the locked torch wheels are CUDA 13); check the families with
#   #   g compute images list --project deeplearning-platform-release --filter='family~common-cu' --format='value(family)'
#   g compute instances create jeeve-train --zone us-west1-b --machine-type g2-standard-8 \
#     --accelerator type=nvidia-l4,count=1 --maintenance-policy TERMINATE \
#     --image-family common-cu129-ubuntu-2404-nvidia-580 --image-project deeplearning-platform-release \
#     --boot-disk-size 150GB --boot-disk-type pd-ssd --scopes storage-full --tags jeeve-train \
#     --max-run-duration 8h --instance-termination-action STOP
#   g compute firewall-rules create jeeve-train-iap-ssh --network default --direction INGRESS \
#     --allow tcp:22 --source-ranges 35.235.240.0/20 --target-tags jeeve-train
#   git archive HEAD | g compute ssh jeeve-train --zone us-west1-b --tunnel-through-iap --command 'sudo mkdir -p /opt/jeeve && sudo tar -x -C /opt/jeeve'
#   g compute ssh jeeve-train --zone us-west1-b --tunnel-through-iap --command 'sudo setsid nohup bash /opt/jeeve/deploy/train/run.sh >/dev/null 2>&1 < /dev/null &'
# Watch: gcloud storage cat "$TRAIN_OUT/train.log" (copied every 10 min). Teardown:
#   g compute instances delete jeeve-train --zone us-west1-b && g compute firewall-rules delete jeeve-train-iap-ssh
# Smaller: CONFIGS=2m STEPS=2000 POWEROFF=0 … bash deploy/train/run.sh
set -euo pipefail
cd "$(dirname "$0")/../../train"
TRAIN_DATA=${TRAIN_DATA:-gs://jeeve-worlddata/v3}
TRAIN_OUT=${TRAIN_OUT:-gs://jeeve-worlddata/train/v3-$(date -u +%Y%m%dT%H%M%S)}
CONFIGS=${CONFIGS:-2m 5m 15m} STEPS=${STEPS:-20000} WORK=${WORK:-/var/tmp/jeeve-train}
mkdir -p "$WORK/out"
exec > >(tee -a "$WORK/out/train.log") 2>&1

copy() { gcloud storage rsync -r "$WORK/out" "$TRAIN_OUT"; }
# However the run ends: the last copy and the VM off, so a failed step never leaves the GPU billing.
finish() {
  kill %1 || true
  copy || true
  [ "${POWEROFF:-1}" != 1 ] || shutdown -h now
}
trap finish EXIT
( while sleep 600; do copy || true; done ) &

echo "data $TRAIN_DATA → $TRAIN_OUT; configs $CONFIGS, $STEPS steps"
nvidia-smi --query-gpu=name,memory.total --format=csv
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
uv sync --locked --no-dev
uv run python -c "import torch; assert torch.cuda.is_available(), 'torch sees no GPU (driver too old for its CUDA?)'; print(torch.__version__, torch.version.cuda)"

gcloud storage rsync -r --exclude='^logs/' "$TRAIN_DATA" "$WORK/episodes" # ~3 GB
uv run python data.py build "$WORK/episodes" "$WORK/shards" 8
du -sh "$WORK/shards"
uv run python baseline.py "$WORK/shards" "$WORK/out/baseline.json"
for c in $CONFIGS; do
  uv run python fit.py "$WORK/shards" "$WORK/out" --config "$c" --steps "$STEPS"
  copy
done
# shellcheck disable=SC2086
best=$(uv run python -c "
import json, sys
b = {c: json.load(open(f'$WORK/out/{c}.json'))['heldout']['per_action']['all']['brier'] for c in sys.argv[1:]}
print(min(b, key=b.get))" $CONFIGS)
echo "best by held-out Brier: $best"
uv run python export.py "$WORK/out/$best.pt" "$WORK/out/onnx"
