#!/usr/bin/env bash
# Rattrape le code sur une stack DÉJÀ DEBOUT — une sandbox partie d'un snapshot (nightly), dont la RAM a gardé les
# process mais dont le code a un ou plusieurs jours de retard (postSnapshotCommand du projet Spunto « spunto-lite »).
# Le dev se recharge seul (tsx watch, next dev) : il ne reste qu'à réinstaller si le lockfile a bougé et à relancer ce
# qui en dépend ; l'image servie sur :3000 est refaite en fond si elle est en retard. Données intactes.
#   bash scripts/catch-up.sh             avance la branche (fast-forward sur son upstream), puis synchronise
#   bash scripts/catch-up.sh --no-pull   synchronise l'environnement sur le checkout tel quel
# Point de départ du diff : le commit noté par le dernier start.sh / catch-up.sh ; à défaut, HEAD avant le pull.
# Les changements non commités comptent.
set -euo pipefail
cd "$(dirname "$0")/.."
PC=scripts/pc
SYNCED=$(git rev-parse --git-path spunto-env-synced)
export CATCH_UP_BASE="${CATCH_UP_BASE:-$(cat "$SYNCED" 2>/dev/null || git rev-parse HEAD)}"

if [ "${1:-}" != "--no-pull" ] && git rev-parse -q --verify '@{u}' >/dev/null; then
  git fetch -q
  git merge --ff-only --autostash -q '@{u}'
  # ce script a pu changer avec le pull : on rejoue sa version à jour
  exec bash scripts/catch-up.sh --no-pull
fi

changed=$(git diff --name-only "$CATCH_UP_BASE" 2>/dev/null || printf '%s\n' process-compose.yaml docker-compose.yml)
echo "▸ spunto-lite : rattrapage de ${CATCH_UP_BASE:0:7} à $(git rev-parse --short HEAD) ($(echo "$changed" | grep -c . || true) fichiers)"

up() { "$PC" process list >/dev/null 2>&1; }
if echo "$changed" | grep -qE '^package(-lock)?\.json$'; then
  echo "  dépendances changées : npm ci puis relance du dev"
  if up; then "$PC" process stop dev >/dev/null; fi
  npm ci --no-audit --no-fund
  if up; then "$PC" process start dev >/dev/null; fi
fi
if echo "$changed" | grep -qx next.config.ts && up; then
  echo "  next.config.ts a changé : relance du dev"   # next dev ne relit pas sa config
  "$PC" process restart dev >/dev/null
fi
if echo "$changed" | grep -qx process-compose.yaml; then
  echo "  process-compose.yaml a changé : relance du dev"
  if up; then "$PC" down >/dev/null; fi
fi
if echo "$changed" | grep -qx docker-compose.yml \
  && [ "$(docker inspect -f '{{.State.Running}}' spunto-lite 2>/dev/null)" = true ]; then
  echo "  docker-compose.yml a changé : conteneur du build recréé (sur l'image en place)"
  docker compose up -d --no-deps --no-build spunto-lite   # le port du build : LITE_PORT, dans .env (start.sh)
fi
# Tout de suite : ce qui ne tourne pas démarre, tout répond, le commit est noté. L'image de :3000 (quelques minutes)
# se refait en fond, pour ne pas faire attendre la tâche qui démarre : :3000 sert l'image précédente jusqu'à la
# bascule. Un start.sh lancé pendant ce temps attend sa fin (verrou).
bash scripts/start.sh --no-build
log="$(git rev-parse --git-path spunto-build.log)"
setsid nohup bash scripts/start.sh > "$log" 2>&1 < /dev/null &
echo "▸ build de :3000 en fond s'il est en retard (journal : $log)"
