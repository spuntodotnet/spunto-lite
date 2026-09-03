#!/usr/bin/env bash
# Génère (une fois) le cert wildcard mkcert de `local.spunto.net` + le rootCA que
# `browser-remote` importe pour lui faire confiance. Idempotent : si les deux
# fichiers sont déjà là, on ne fait rien.
#
# Porté de `coderhammer/spunto` (`local-https/generate-certs.sh`), à l'identique
# à ceci près que le domaine est paramétrable par `LOCAL_DOMAIN` — spunto le
# code en dur, mais ici le même script doit pouvoir servir un autre domaine sans
# être forké.
#
# mkcert tourne dans un conteneur jetable : aucun binaire à installer sur l'hôte.
set -e

DOMAIN="${LOCAL_DOMAIN:-local.spunto.net}"
CERTS_DIR="${CERTS_DIR:-local-https/certs}"
mkdir -p "$CERTS_DIR"

if [ -f "$CERTS_DIR/$DOMAIN.pem" ] && [ -f "$CERTS_DIR/rootCA.pem" ]; then
  echo "✓ Certs déjà présents dans $CERTS_DIR/ — rien à faire"
  exit 0
fi

echo "→ Génération du cert mkcert wildcard $DOMAIN..."
docker run --rm \
  -v "$(pwd)/$CERTS_DIR:/certs" \
  -e CAROOT=/certs \
  -e DOMAIN="$DOMAIN" \
  -e OWNER="$(id -u):$(id -g)" \
  debian:bookworm-slim sh -c '
    set -e
    apt-get update -qq && apt-get install -y -qq wget libnss3-tools >/dev/null 2>&1
    wget -q "https://dl.filippo.io/mkcert/latest?for=linux/amd64" -O /usr/local/bin/mkcert
    chmod +x /usr/local/bin/mkcert
    mkcert -install
    mkcert -cert-file "/certs/$DOMAIN.pem" \
           -key-file "/certs/$DOMAIN-key.pem" \
           "$DOMAIN" "*.$DOMAIN"
    # Avec un démon Docker classique les fichiers sortiraient en root:root, illisibles
    # pour l'\''utilisateur courant. On rend la main ici plutôt qu'\''avec un `sudo` après
    # coup : spunto le fait en sudo, mais un worker Spunto n'\''en a pas forcément un.
    # (Démon rootless : le chown est un no-op, les fichiers sont déjà au bon uid.)
    chown -R "$OWNER" /certs
  '
echo "✓ Certs générés dans $CERTS_DIR/"
