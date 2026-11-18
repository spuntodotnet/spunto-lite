#!/usr/bin/env bash
# Un spunto-lite de plus, isolé, à côté de la stack (essai sur une base vide, suite e2e, deux variantes comparées) :
# son port, ses données, et sa propre copie du code — `next dev` refuse de tourner deux fois dans le même dossier
# (« Another next dev server is already running »), donc `PORT=… npm run dev` dans le checkout ne marche pas tant que
# le dev de :3010 tourne.
#   bash scripts/instance.sh 3900           au premier plan (Ctrl-C, ou fuser -k 3900/tcp, pour l'arrêter)
#   bash scripts/instance.sh 3900 --fresh   en repartant d'une base vide
# La copie : ../spunto-lite-instances/<port>/src, l'état du checkout au lancement (non commité compris), node_modules en
# liens physiques (instantané, rien de copié) ; les données dans …/<port>/data. Pour reprendre le code : relancer.
# Pour tout effacer : rm -rf ../spunto-lite-instances/<port>.
set -euo pipefail
cd "$(dirname "$0")/.."
port="${1:-}"; fresh="${2:-}"
case "$port" in
  ''|*[!0-9]*) echo "usage : bash scripts/instance.sh <port> [--fresh]" >&2; exit 2 ;;
  80|443|3000|3005|3010) echo "✗ :$port est à la stack (3000 build, 3010 dev, 3005 browser-remote) : prends-en un autre" >&2; exit 2 ;;
esac
if curl -s -o /dev/null --max-time 1 "http://localhost:$port/"; then echo "✗ :$port est déjà pris" >&2; exit 1; fi

root="$PWD"
dir="$(dirname "$root")/$(basename "$root")-instances/$port"
[ "$fresh" != --fresh ] || rm -rf "${dir:?}/data"
mkdir -p "$dir/src" "$dir/data"

# Le code : on remplace tout sauf node_modules et .next (le cache de next dev).
find "$dir/src" -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .next -exec rm -rf {} +
git ls-files -co --exclude-standard -z | while IFS= read -r -d '' f; do if [ -e "$f" ]; then printf '%s\0' "$f"; fi; done \
  | tar --null -T - -cf - | tar -xf - -C "$dir/src"
if ! cmp -s package-lock.json "$dir/src/node_modules/.spunto-lockfile" 2>/dev/null; then
  rm -rf "$dir/src/node_modules"
  cp -al node_modules "$dir/src/node_modules" 2>/dev/null || cp -a node_modules "$dir/src/node_modules"
  cp package-lock.json "$dir/src/node_modules/.spunto-lockfile"
fi

echo "▸ instance isolée : http://localhost:$port/  (code : $dir/src, données : $dir/data)"
cd "$dir/src"
exec env PORT="$port" DATA_DIR="$dir/data" BASE_DOMAIN=localhost npm run dev
