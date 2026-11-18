#!/usr/bin/env bash
# Installation de spunto-lite sur un worker neuf (postCreateCommand du projet Spunto « spunto-lite ») : dépendances
# npm (le dev tourne sur l'hôte) et process-compose (qui le fait tourner : scripts/start.sh). Le build, lui, s'installe
# dans son image Docker (Dockerfile). Rejouable sans risque.
#   bash scripts/init.sh
set -euo pipefail
cd "$(dirname "$0")/.."
echo "▸ spunto-lite : installation ($(pwd))"
npm ci --no-audit --no-fund
scripts/pc version >/dev/null                # installe process-compose s'il manque
echo "▸ spunto-lite installé. Lancement : bash scripts/start.sh"
