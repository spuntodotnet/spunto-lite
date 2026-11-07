---
title: Configuration
description: Every environment variable of the Lite container, the extension gallery, private registries, HTTPS and a custom domain, and the dashboard's settings.
group: operate
order: 1
---

Lite works with no configuration at all. Everything below is optional — except a real
`DATA_ENCRYPTION_KEY` as soon as you store a secret you care about.

## Environment variables

| Variable | Default | |
|---|---|---|
| `DATA_ENCRYPTION_KEY` | an insecure dev key | encrypts stored secrets (AES-256-GCM). `openssl rand -hex 32`, and keep it |
| `PORT` | `80` | the port Lite listens on — the app and the worker proxy |
| `BASE_DOMAIN` | `localhost` | suffix of the worker URLs: `worker-<id>.<BASE_DOMAIN>`. Comma-separated to answer on several; the first is the one handed to workers |
| `DATA_DIR` | `/app/data` in the image | where the SQLite database lives — mount a volume there |
| `HOST_SSH_DIR` | `/host-ssh` | where your `~/.ssh` is mounted, read-only |
| `SSH_AGENT_DIR` | `/run/spunto-ssh-agent` | directory of the agent socket every worker mounts — must be a volume |
| `HOST_SSH_AUTH_SOCK` | `/run/host-services/ssh-auth.sock` | where your host's forwarded agent is mounted, if it is |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | unset | set both to also serve HTTPS |
| `TLS_PORT` | `443` | the HTTPS port, when TLS is on |
| `EXTENSIONS_GALLERY` | Open VSX | a VS Code extension gallery, as code-server's JSON |
| `GCP_SA_KEY` | unset | fallback key for private Google Artifact Registry / GCR base images |

## Extension gallery

The extension picker searches [Open VSX](https://open-vsx.org) by default. Set
`EXTENSIONS_GALLERY` — the same JSON code-server takes — and three things switch together: the
picker's search, the `--install-extension` calls of the image build, and the code-server inside
every worker. What you can find stays what you can install.

```bash
docker run -d --name spunto-lite -p 80:80 \
  -e EXTENSIONS_GALLERY='{"serviceUrl":"https://gallery.example.com/_apis/public/gallery","itemUrl":"https://gallery.example.com/items"}' \
  … ghcr.io/spuntodotnet/spunto-lite:latest
```

Add an optional `"productTarget"` key when the gallery serves several products' catalogues and you
want results scoped to the editor's. Images are cached per version: **rebuild** a project for its
pre-installed extensions to be resolved against a gallery you just changed. Which gallery you
point this at, and under which terms, is yours to decide.

## Private base images

For a base image in a private **Google Artifact Registry** or **GCR**, give Lite a service-account
key with `roles/artifactregistry.reader` in **Settings → Container registry** — stored encrypted in
the database. `GCP_SA_KEY` (raw JSON, or base64 on one line: `base64 -w0 sa-key.json`) is the
headless fallback; the Settings value wins when both are set.

For other private registries, log the host's Docker in (`docker login`): image builds go through
the host daemon.

## HTTPS and another domain

Lite routes by subdomain, so whatever name you use needs a **wildcard**: `*.<BASE_DOMAIN>` must
resolve to the machine running Lite.

- **On your own machine**, `*.localhost` already does, in every major browser. Nothing to do.
- **From another device on your network**, point a wildcard DNS record at the machine
  (`*.lite.home.arpa`, or a real domain), set `BASE_DOMAIN` to it, and — if you want HTTPS — a
  wildcard certificate in `TLS_CERT_FILE` / `TLS_KEY_FILE`. Read [Security](/docs/security) first:
  there is no login screen.

With TLS on, Lite also listens on `TLS_PORT`; plain HTTP on `PORT` keeps working. For a trusted local
certificate, [mkcert](https://github.com/FiloSottile/mkcert) makes one for a wildcard; the
repository's `local-https/generate-certs.sh` does it for `*.local.spunto.net`, the domain its own
tests use from inside containers.

## In the dashboard

- **Settings → SSH keys** — the key given to workers, unlocking one with a passphrase
  ([SSH keys and git](/docs/ssh-and-git)).
- **Settings → MCP servers** — see [MCP servers](/docs/mcp-servers).
- **Settings → Container registry** — above.
- **Settings → Appearance** — the dashboard's colour: Lite's own blue, another Spunto product's
  pair, or one of the design system's palettes. Light and dark themes from the header.
- **⌘K** (Ctrl+K elsewhere) — jumps to any project, workspace, service, port, image build, secret
  name or template.
