---
title: Installation
description: Run Spunto Lite with one docker run or a compose file, then upgrade, back up and uninstall it.
group: start
order: 2
---

Spunto Lite is a single container. It needs the Docker socket (to create the workers next to it),
your `~/.ssh` (read-only), and two volumes: one for its data, one for the SSH agent socket it shares
with the workers.

## With `docker run`

```bash
docker run -d --name spunto-lite --restart unless-stopped -p 80:80 \
  -e DATA_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.ssh:/host-ssh:ro" \
  -v spunto-lite-ssh-agent:/run/spunto-ssh-agent \
  -v spunto-lite-data:/app/data \
  ghcr.io/spuntodotnet/spunto-lite:latest
```

Then open **http://localhost**. There is no account to create and no login screen.

> **Keep the encryption key.** `DATA_ENCRYPTION_KEY` encrypts every secret you store. Generate it
> once, write it down, and pass the same value every time you recreate the container — with another
> key, the stored secrets can't be decrypted. Without it, Lite falls back to an insecure
> development key.

## With compose

Save this as `docker-compose.yml`, put `DATA_ENCRYPTION_KEY=…` in a `.env` file next to it, and run
`docker compose up -d`:

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
      # Optional — forward your host's ssh-agent (see "SSH keys and git"):
      #   macOS (Docker Desktop):
      # - /run/host-services/ssh-auth.sock:/run/host-services/ssh-auth.sock
      #   Linux:
      # - ${SSH_AUTH_SOCK}:/run/host-services/ssh-auth.sock

volumes:
  spunto-lite-data:
  spunto-lite-ssh-agent:
```

## From source

The repository's own compose file builds the image from the checkout and adds the local HTTPS
domain used by its tests:

```bash
git clone https://github.com/spuntodotnet/spunto-lite.git
cd spunto-lite
cp .env.example .env          # optional — sane defaults work out of the box
docker compose up -d --build  # or ./start.sh
```

## Another port

If port 80 is taken, publish another one and tell Lite about it, so the URLs it hands out match:

```bash
docker run … -p 8080:8080 -e PORT=8080 … ghcr.io/spuntodotnet/spunto-lite:latest
```

Workers are then at `http://worker-<id>.localhost:8080`.

## Check that it runs

```bash
curl -s http://localhost/api/health
docker logs -f spunto-lite
```

## Upgrade

Pull the new image and recreate the container with the **same volumes and the same key**:

```bash
docker pull ghcr.io/spuntodotnet/spunto-lite:latest
docker rm -f spunto-lite
docker run -d --name spunto-lite …   # the same command as above
# or, with compose:
docker compose pull && docker compose up -d
```

Database migrations run on start. Workers are separate containers: they don't go anywhere during
the upgrade, their agents reconnect once Lite is back, and a stopped worker starts as usual. When a release changes what goes into a workspace
image, the project's image is rebuilt on the next launch instead of leaving your workers on the
old recipe. Besides `latest`, every release is tagged by version and every build by its short
commit SHA, if you'd rather pin one.

## Back up

Everything Lite knows is in the `spunto-lite-data` volume — one SQLite file. Back it up and you've
backed up the installation (keep the encryption key with it):

```bash
docker run --rm -v spunto-lite-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/spunto-lite-data.tgz -C /data .
```

Your workers' files are in their own volumes (`mp-worker-<id>-workspace`), and a project's shared
volumes in `mp-proj-<projectId>-<name>`: back those up separately if they hold anything you can't
clone again.

## Uninstall

Delete your projects from the dashboard first — that removes their workers, images and volumes —
then remove Lite itself:

```bash
docker rm -f spunto-lite
docker volume rm spunto-lite-data spunto-lite-ssh-agent
```

Anything left over is named `mp-…` (`docker ps -a`, `docker volume ls`, `docker images`).
