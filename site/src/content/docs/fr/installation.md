---
title: "Installation"
description: "Lancer Spunto Lite avec un seul docker run ou un fichier compose, puis le mettre à jour, le sauvegarder et le désinstaller."
group: start
order: 2
---

Spunto Lite est un seul conteneur. Il a besoin du socket Docker (pour créer les workers à côté de
lui), de votre `~/.ssh` (en lecture seule) et de deux volumes : l’un pour ses données, l’autre pour
le socket de l’agent SSH qu’il partage avec les workers.

## Avec `docker run`

```bash
docker run -d --name spunto-lite --restart unless-stopped -p 80:80 \
  -e DATA_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.ssh:/host-ssh:ro" \
  -v spunto-lite-ssh-agent:/run/spunto-ssh-agent \
  -v spunto-lite-data:/app/data \
  ghcr.io/spuntodotnet/spunto-lite:latest
```

Ouvrez ensuite **http://localhost**. Il n’y a pas de compte à créer ni d’écran de connexion.

> **Conservez la clé de chiffrement.** `DATA_ENCRYPTION_KEY` chiffre tous les secrets que vous
> enregistrez. Générez-la une fois, notez-la, et passez la même valeur chaque fois que vous recréez
> le conteneur — avec une autre clé, les secrets enregistrés ne peuvent plus être déchiffrés. Sans
> elle, Lite se rabat sur une clé de développement non sécurisée.

## Avec compose

Enregistrez ceci sous `docker-compose.yml`, mettez `DATA_ENCRYPTION_KEY=…` dans un fichier `.env`
à côté, et lancez `docker compose up -d` :

```yaml
services:
  spunto-lite:
    image: ghcr.io/spuntodotnet/spunto-lite:latest
    container_name: spunto-lite
    restart: unless-stopped
    ports: ["80:80"]
    environment:
      DATA_ENCRYPTION_KEY: ${DATA_ENCRYPTION_KEY}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${HOME}/.ssh:/host-ssh:ro
      - spunto-lite-ssh-agent:/run/spunto-ssh-agent
      - spunto-lite-data:/app/data
      # Facultatif — relayer l'ssh-agent de l'hôte (voir « Clés SSH et git ») :
      #   macOS (Docker Desktop) :
      # - /run/host-services/ssh-auth.sock:/run/host-services/ssh-auth.sock
      #   Linux :
      # - ${SSH_AUTH_SOCK}:/run/host-services/ssh-auth.sock

volumes:
  spunto-lite-data:
  spunto-lite-ssh-agent:
```

## Depuis les sources

Le fichier compose du dépôt construit l’image à partir du checkout et ajoute le domaine HTTPS
local utilisé par ses tests :

```bash
git clone https://github.com/spuntodotnet/spunto-lite.git
cd spunto-lite
cp .env.example .env          # facultatif — les valeurs par défaut conviennent d'emblée
docker compose up -d --build  # ou ./start.sh
```

## Un autre port

Si le port 80 est pris, publiez-en un autre et indiquez-le à Lite, pour que les URL qu’il fournit
correspondent :

```bash
docker run … -p 8080:8080 -e PORT=8080 … ghcr.io/spuntodotnet/spunto-lite:latest
```

Les workers sont alors à `http://worker-<id>.localhost:8080`.

## Vérifier qu’il tourne

```bash
curl -s http://localhost/api/health
docker logs -f spunto-lite
```

## Mettre à jour

Récupérez la nouvelle image et recréez le conteneur avec **les mêmes volumes et la même clé** :

```bash
docker pull ghcr.io/spuntodotnet/spunto-lite:latest
docker rm -f spunto-lite
docker run -d --name spunto-lite …   # la même commande que ci-dessus
# ou, avec compose :
docker compose pull && docker compose up -d
```

Les migrations de la base s’exécutent au démarrage. Les workers sont des conteneurs distincts : ils
ne bougent pas pendant la mise à jour, leurs agents se reconnectent dès que Lite est revenu, et un
worker arrêté démarre comme d’habitude. Quand une version modifie ce qui entre dans une image
d’espace de travail, l’image du projet est reconstruite au lancement suivant, plutôt que de laisser
vos workers sur l’ancienne recette. Outre `latest`, chaque version est étiquetée par son numéro et
chaque build par le SHA court de son commit, si vous préférez en épingler un.

## Sauvegarder

Tout ce que Lite sait se trouve dans le volume `spunto-lite-data` — un seul fichier SQLite.
Sauvegardez-le et vous avez sauvegardé l’installation (gardez la clé de chiffrement avec) :

```bash
docker run --rm -v spunto-lite-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/spunto-lite-data.tgz -C /data .
```

Les fichiers de vos workers sont dans leurs propres volumes (`mp-worker-<id>-workspace`), et les
volumes partagés d’un projet dans `mp-proj-<projectId>-<name>` : sauvegardez-les à part s’ils
contiennent quelque chose que vous ne pouvez pas recloner.

## Désinstaller

Supprimez d’abord vos projets depuis le tableau de bord — cela supprime leurs workers, leurs images
et leurs volumes — puis supprimez Lite lui-même :

```bash
docker rm -f spunto-lite
docker volume rm spunto-lite-data spunto-lite-ssh-agent
```

Tout ce qui reste porte un nom en `mp-…` (`docker ps -a`, `docker volume ls`, `docker images`).
