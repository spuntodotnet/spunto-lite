#!/usr/bin/env bash
# Démarrage de spunto-lite sur un worker Spunto (postStartCommand du projet « spunto-lite »). Deux spunto-lite, pour
# deux publics, chacun avec ses données :
#   :3000  le BUILD : l'image Docker, celle que la CI publie sur GHCR (Dockerfile), lancée par docker-compose.yml
#          comme chez un utilisateur — ce qu'ouvre l'humain qui teste, le lien à lui donner
#   :3010  le dev (`npm run dev` sous process-compose : tsx relance le serveur, next dev recharge à chaud) — pour qui
#          itère
# Rejouable (le hook Stop le lance à la fin de chaque tour) : ne relance rien qui tourne, refait l'image seulement si
# le contenu de ses sources a changé, et attend que tout réponde.
#   bash scripts/start.sh               logs : pc process logs dev -f · docker compose logs -f spunto-lite
#   bash scripts/start.sh --no-build    sans refaire l'image (sert la dernière, même en retard)
#   bash scripts/start.sh restart       relance le dev et recrée le conteneur du build
#   bash scripts/start.sh stop
set -euo pipefail
cd "$(dirname "$0")/.."
PC=scripts/pc
DEV_PORT=3010
export LITE_PORT=3000                        # docker-compose.yml : le build publié sur :3000 (il écoute sur 80 dedans)
sudo -n ln -sf "$PWD/scripts/pc" /usr/local/bin/pc 2>/dev/null || true

BUILD=1 MODE=start
for a in "$@"; do
  case "$a" in
    start) ;;
    restart|stop) MODE=$a ;;
    --no-build) BUILD=0 ;;
    *) echo "usage : bash scripts/start.sh [start|restart|stop] [--no-build]" >&2; exit 2 ;;
  esac
done

up() { "$PC" process list >/dev/null 2>&1; }
ready() {
  "$PC" process list -o json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { process.exit(JSON.parse(s).every((p) => !p.has_ready_probe || p.is_ready === "Ready") ? 0 : 1) }
      catch { process.exit(1) }
    })'
}
# `pc down` rend la main avant que le process ait fini : on attend que le port se libère
down() {
  if up; then "$PC" down >/dev/null; fi
  for _ in $(seq 1 15); do curl -s -o /dev/null --max-time 1 "http://localhost:$DEV_PORT/" || break; sleep 1; done
}
running() { [ "$(docker inspect -f '{{.State.Running}}' spunto-lite 2>/dev/null)" = true ]; }

# Au démarrage du worker, docker-in-docker peut ne pas être encore levé quand Spunto lance le postStart.
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { echo "✗ démon Docker injoignable après 60 s" >&2; exit 1; }

recreate=()
case "$MODE" in
  stop) down; docker compose stop >/dev/null 2>&1 || true; echo "▸ spunto-lite arrêté"; exit 0 ;;
  restart) down; recreate=(--force-recreate) ;;
esac

# dépendances absentes (worker créé avant le script d'installation) : on installe d'abord
[ -d node_modules ] || bash scripts/init.sh
# Montés par docker-compose.yml : absents, Docker les créerait au nom de root.
mkdir -p data local-https/certs
[ -d "$HOME/.ssh" ] || install -d -m 700 "$HOME/.ssh"

if ! up; then
  rm -f "$HOME/.process-compose/pc.sock"
  "$PC" up -D -f process-compose.yaml -L "$HOME/.process-compose/process-compose.log"
fi

# Le build servi sur :3000 : l'image de docker-compose.yml. Elle est périmée quand le CONTENU de ses sources a changé
# (empreinte de ce que git suit dans le contexte du build : commité, modifié ou nouveau non ignoré), pas leur date.
# Hors empreinte : ce qui ne change rien à ce que l'image fait tourner (doc, tests, site, outils du dépôt). On construit
# la nouvelle image pendant que l'ancienne sert, puis le conteneur est recréé dessus (quelques secondes de coupure) ; un
# build qui échoue laisse l'ancien en place. Un seul build à la fois (verrou), y compris celui que scripts/catch-up.sh
# lance en fond.
SOURCES=(. ':!:site' ':!:e2e' ':!:docs' ':!:scripts' ':!:mcp' ':!:local-https' ':!:.github' ':!:.claude'
  ':!:*.md' ':!:LICENSE' ':!:.mcp.json' ':!:.env.example' ':!:process-compose.yaml' ':!:tsconfig.tsbuildinfo')
BUILT="$(git rev-parse --git-path spunto-build-sources)"
fingerprint() {
  { git ls-files -s -- "${SOURCES[@]}"; git diff HEAD -- "${SOURCES[@]}"
    git ls-files -o --exclude-standard -z -- "${SOURCES[@]}" | xargs -0r sha1sum; } | sha1sum | cut -c1-40
}
stale() { [ "$(cat "$BUILT" 2>/dev/null)" != "$(fingerprint)" ]; }
rebuilt=0
if [ "$BUILD" = 1 ] && stale; then
  exec 9>"$(git rev-parse --git-path spunto-build.lock)"
  flock 9
  if stale; then                             # un autre build a pu finir pendant qu'on attendait le verrou
    echo "▸ build de l'image (le conteneur en place sert pendant ce temps)"
    sources="$(fingerprint)"                 # avant : un changement pendant le build le laisse périmé
    old="$(docker inspect -f '{{.Image}}' spunto-lite 2>/dev/null || true)"
    docker compose --progress plain build spunto-lite
    docker compose up -d --no-deps --no-build "${recreate[@]}" spunto-lite
    printf '%s\n' "$sources" > "$BUILT"
    new="$(docker inspect -f '{{.Image}}' spunto-lite)"
    [ -z "$old" ] || [ "$old" = "$new" ] || docker image rm "$old" >/dev/null 2>&1 || true
    rebuilt=1
  fi
  flock -u 9
fi
if [ "$rebuilt" = 0 ] && { [ "${#recreate[@]}" -gt 0 ] || ! running; }; then
  if docker image inspect "$(docker compose config --images spunto-lite)" >/dev/null 2>&1; then
    docker compose up -d --no-deps --no-build "${recreate[@]}" spunto-lite
  fi
fi

wait_http() { for _ in $(seq 1 "$2"); do curl -sf -o /dev/null --max-time 5 "$1" && return 0; sleep 1; done; return 1; }
for _ in $(seq 1 180); do ready && break; sleep 1; done
if ! ready; then
  echo "✗ le dev (:$DEV_PORT) n'a pas démarré : pc process logs dev, ou ~/.process-compose/logs/dev.log" >&2
  exit 1
fi
if running && ! wait_http "http://localhost:$LITE_PORT/api/health" 120; then
  echo "✗ le build (:$LITE_PORT) ne répond pas : docker compose logs spunto-lite" >&2
  exit 1
fi
# commit auquel l'environnement correspond : point de départ du diff de scripts/catch-up.sh
git rev-parse HEAD > "$(git rev-parse --git-path spunto-env-synced)" 2>/dev/null || true
url() { if [ -n "${WORKER_SLUG:-}" ]; then echo "https://$WORKER_SLUG-$1.${BASE_DOMAIN:-spunto.net}"; else echo "http://localhost:$1"; fi; }
if ! running; then echo "⚠ pas encore de build sur :$LITE_PORT : bash scripts/start.sh"
elif stale; then echo "⚠ le build sur :$LITE_PORT est en retard sur le code : bash scripts/start.sh"; fi
echo "▸ spunto-lite lancé — à tester (le build) : $(url $LITE_PORT)/   ·   à itérer (dev) : $(url $DEV_PORT)/"
