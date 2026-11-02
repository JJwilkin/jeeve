#!/usr/bin/env bash
# 2B's authoring run on the smoke VM (brain/tasks/world-model-data.md → "How they're made"): one superflat Paper
# server and collect/author.ts in the jeeve image, traced to Judgment project jeeve-test. Run from the Mac with the
# keys sent down stdin ahead of the script (as deploy/README.md does for TS_AUTHKEY): bash runs them as assignments,
# and they reach Node through a pipe (--env-file=/dev/stdin), so they never land in a file, a command line, the
# container's config or a log:
#   { grep -E '^(ANTHROPIC_API_KEY|JUDGMENT_API_KEY|JUDGMENT_ORG_ID|JUDGMENT_API_URL)=' ../judgment/.env.jeeve; cat deploy/collect/author.sh; } |
#     g compute ssh jeeve-collect-smoke --tunnel-through-iap --command 'sudo MINECRAFT_EULA=true AUTHOR_MAX_USD=25 bash -s'
# Needs Docker and a checkout of this repo at JEEVE_DIR (default /opt/jeeve). ACTIONS picks some (bridge,swim_across,
# shelter). Output in that checkout: collect/actions/<name>.ts for each accepted action, authoring/<session>.json
# (the report), authoring/author.log, and the builder's local trace rows in authoring/traces/.
set -euo pipefail

# One function, so bash has read the whole script (and the keys ahead of it) before running any of it.
main() {
  : "${ANTHROPIC_API_KEY:?send it down stdin}" "${JUDGMENT_API_KEY:?send it down stdin}"
  cd "${JEEVE_DIR:-/opt/jeeve}"
  docker build -q -t jeeve .
  local pw paper=jeeve-author-paper
  pw=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n') # RCON stays on this Docker network; this only keeps it closed
  docker network create jeeve-author >/dev/null 2>&1 || true
  docker rm -f "$paper" >/dev/null 2>&1 || true
  # As collect/compose.ts's servers, but superflat: scripts/scenes.ts builds on its ground.
  docker run -d --name "$paper" --network jeeve-author \
    -e EULA="${MINECRAFT_EULA:-false}" -e TYPE=PAPER -e VERSION=26.1.2 -e PAPER_BUILD=74 -e MEMORY=3G \
    -e LEVEL_TYPE=minecraft:flat -e GENERATE_STRUCTURES=false -e ONLINE_MODE=FALSE -e ENFORCE_SECURE_PROFILE=FALSE \
    -e ALLOW_FLIGHT=TRUE -e SPAWN_PROTECTION=0 -e DIFFICULTY=easy -e VIEW_DISTANCE=6 -e SIMULATION_DISTANCE=6 \
    -e ENABLE_RCON=true -e RCON_PASSWORD="$pw" \
    itzg/minecraft-server:java25@sha256:f7f2222512810f0f0e85133913622cf639be77a5dd1d4b11f24ab675da6ba742 >/dev/null
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$paper")" = healthy ]; do sleep 5; done

  mkdir -p authoring/traces collect/actions && chown 1000:1000 authoring authoring/traces collect/actions
  printf 'ANTHROPIC_API_KEY=%s\nJUDGMENT_API_KEY=%s\nJUDGMENT_ORG_ID=%s\nJUDGMENT_API_URL=%s\n' \
    "$ANTHROPIC_API_KEY" "$JUDGMENT_API_KEY" "${JUDGMENT_ORG_ID:-}" "${JUDGMENT_API_URL:-}" |
    docker run -i --rm --network jeeve-author \
      -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/collect/actions:/app/collect/actions" \
      -v "$PWD/authoring:/app/authoring" -v "$PWD/authoring/traces:/app/traces" \
      -e AUTHOR_HOST="$paper" -e AUTHOR_RCON_PASSWORD="$pw" -e AUTHOR_MAX_USD="${AUTHOR_MAX_USD:-25}" \
      -e JEEVE_PROJECT=jeeve-test -e JEEVE_ENVIRONMENT=authoring \
      jeeve node --env-file=/dev/stdin collect/author.ts ${ACTIONS:-} 2>&1 | tee authoring/author.log
  docker rm -f "$paper" >/dev/null
}
main
