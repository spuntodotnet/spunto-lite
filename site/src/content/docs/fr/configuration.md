---
title: "Configuration"
description: "Toutes les variables d’environnement du conteneur Lite, la galerie d’extensions, les registres privés, HTTPS et un domaine personnalisé, et les réglages du tableau de bord."
group: operate
order: 1
---

Lite fonctionne sans aucune configuration. Tout ce qui suit est facultatif — sauf une vraie
`DATA_ENCRYPTION_KEY` dès que vous enregistrez un secret qui compte.

## Variables d’environnement

| Variable | Par défaut | |
|---|---|---|
| `DATA_ENCRYPTION_KEY` | une clé de dev non sécurisée | chiffre les secrets enregistrés (AES-256-GCM). `openssl rand -hex 32`, et conservez-la |
| `PORT` | `80` | le port sur lequel Lite écoute — l’application et le proxy des workers |
| `BASE_DOMAIN` | `localhost` | suffixe des URL des workers : `worker-<id>.<BASE_DOMAIN>`. Plusieurs valeurs séparées par des virgules pour répondre sur plusieurs domaines ; la première est celle fournie aux workers |
| `DATA_DIR` | `/app/data` dans l’image | l’emplacement de la base SQLite — montez-y un volume |
| `HOST_SSH_DIR` | `/host-ssh` | l’emplacement où votre `~/.ssh` est monté, en lecture seule |
| `SSH_AGENT_DIR` | `/run/spunto-ssh-agent` | le répertoire du socket d’agent que monte chaque worker — doit être un volume |
| `HOST_SSH_AUTH_SOCK` | `/run/host-services/ssh-auth.sock` | l’emplacement où l’agent relayé de votre hôte est monté, s’il l’est |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | non définies | définissez les deux pour servir aussi en HTTPS |
| `TLS_PORT` | `443` | le port HTTPS, quand TLS est activé |
| `EXTENSIONS_GALLERY` | Open VSX | une galerie d’extensions VS Code, au format JSON de code-server |
| `GCP_SA_KEY` | non définie | clé de secours pour les images de base d’un Google Artifact Registry / GCR privé |

## Galerie des extensions

Le sélecteur d’extensions cherche par défaut sur [Open VSX](https://open-vsx.org). Définissez
`EXTENSIONS_GALLERY` — le même JSON que celui de code-server — et trois choses basculent ensemble :
la recherche du sélecteur, les appels `--install-extension` du build de l’image, et le code-server
de chaque worker. Ce que vous pouvez trouver reste ce que vous pouvez installer.

```bash
docker run -d --name spunto-lite -p 80:80 \
  -e EXTENSIONS_GALLERY='{"serviceUrl":"https://gallery.example.com/_apis/public/gallery","itemUrl":"https://gallery.example.com/items"}' \
  … ghcr.io/spuntodotnet/spunto-lite:latest
```

Ajoutez une clé `"productTarget"` facultative quand la galerie sert les catalogues de plusieurs
produits et que vous voulez des résultats limités à celui de l’éditeur. Les images sont mises en
cache par version : faites un **rebuild** d’un projet pour que ses extensions préinstallées soient
résolues auprès d’une galerie que vous venez de changer. Le choix de la galerie visée, et des
conditions sous lesquelles vous l’utilisez, vous appartient.

## Images de base privées

Pour une image de base dans un **Google Artifact Registry** ou **GCR** privé, donnez à Lite une clé
de compte de service dotée de `roles/artifactregistry.reader` dans **Settings → Container
registry** — stockée chiffrée dans la base. `GCP_SA_KEY` (JSON brut, ou base64 sur une seule ligne :
`base64 -w0 sa-key.json`) est la solution de secours sans interface ; la valeur des Settings
l’emporte quand les deux sont définies.

Pour les autres registres privés, connectez le Docker de l’hôte (`docker login`) : les builds
d’images passent par le démon de l’hôte.

## HTTPS et un autre domaine

Lite route par sous-domaine : quel que soit le nom utilisé, il lui faut un **wildcard** :
`*.<BASE_DOMAIN>` doit se résoudre vers la machine qui fait tourner Lite.

- **Sur votre propre machine**, c’est déjà le cas de `*.localhost`, dans tous les navigateurs
  majeurs. Rien à faire.
- **Depuis un autre appareil de votre réseau**, faites pointer un enregistrement DNS wildcard vers
  la machine (`*.lite.home.arpa`, ou un vrai domaine), réglez `BASE_DOMAIN` dessus et — si vous
  voulez du HTTPS — placez un certificat wildcard dans `TLS_CERT_FILE` / `TLS_KEY_FILE`. Lisez
  d’abord [Sécurité](/fr/docs/security) : il n’y a pas d’écran de connexion.

Avec TLS activé, Lite écoute aussi sur `TLS_PORT` ; le HTTP simple sur `PORT` continue de
fonctionner. Pour un certificat local de confiance, [mkcert](https://github.com/FiloSottile/mkcert)
en fabrique un pour un wildcard ; le script `local-https/generate-certs.sh` du dépôt le fait pour
`*.local.spunto.net`, le domaine qu’utilisent ses propres tests depuis l’intérieur des conteneurs.

## Dans le tableau de bord

- **Settings → SSH keys** — la clé donnée aux workers, le déverrouillage d’une clé à phrase de
  passe ([Clés SSH et git](/fr/docs/ssh-and-git)).
- **Settings → MCP servers** — voir [Serveurs MCP](/fr/docs/mcp-servers).
- **Settings → Container registry** — ci-dessus.
- **Settings → Appearance** — la couleur du tableau de bord : le bleu propre à Lite, la paire d’un
  autre produit Spunto, ou l’une des palettes du design system. Thèmes clair et sombre depuis
  l’en-tête.
- **⌘K** (Ctrl+K ailleurs) — saute vers n’importe quel projet, espace de travail, service, port,
  build d’image, nom de secret ou modèle.
