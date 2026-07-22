# Spunto Lite

A **local dev-environment control plane** — the "Build" pillar of
[Spunto](https://spunto.net), collapsed into a single container you run on your
own machine. Create projects (devcontainer-style specs), launch Docker workers
with **VS Code in the browser** (code-server), a **persistent terminal**,
**lifecycle hooks** (`postCreate`/`postStart`), **secrets**, and your **own SSH
key** injected so `git push` just works.

No cloud, no multi-tenant, no remote agents: one Next.js process talking straight
to your local Docker socket.

## Quick start

```bash
cp .env.example .env          # optional — sane defaults work out of the box
docker compose up -d --build
```

Or run the pre-built image straight from GHCR:

```bash
docker run -d --name spunto-lite -p 80:80 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.ssh:/host-ssh:ro" \
  -v spunto-lite-data:/app/data \
  ghcr.io/spuntodotnet/spunto-lite:latest
```

Then open **http://localhost**. Workers appear at
`http://worker-<id>.localhost` (VS Code) and
`http://worker-<id>-<port>.localhost` (forwarded ports). `*.localhost` resolves
to `127.0.0.1` automatically in Chrome/Edge/Firefox.

## How it works

- **One Next.js app** (App Router) served by a small custom Node server
  (`server.ts`) that also reverse-proxies worker subdomains and hosts the
  terminal WebSocket.
- **`dockerode`** → `/var/run/docker.sock`: workers are sibling containers on the
  host daemon.
- **SQLite** (via Drizzle) for projects/workers/secrets, in a Docker volume.
- **`~/.ssh` mounted read-only** and injected into each worker for git identity.

## Requirements

- Docker with the socket at `/var/run/docker.sock`
- Port 80 free on the host (override with `PORT`, at the cost of `:port` in URLs)

## Development

```bash
npm install
npm run db:generate     # regenerate SQL migrations after schema changes
PORT=3900 npm run dev    # run the control plane directly (needs a reachable Docker socket)
```

## Testing

End-to-end tests live in [`e2e/`](e2e/README.md) — a [Playwright](https://playwright.dev)
suite split into an HTTP-only **API** project and a **browser** project (driving
[`browser-remote`](https://github.com/spuntodotnet/browser-remote)'s Chrome over CDP, or a local
Chromium). No auth to set up (the control plane is open); SQLite means no DB service either.

```bash
# fast API suite — boot the app, then run the `api` project
PORT=3900 DATA_DIR=./.e2e-data npm run dev
cd e2e && npm install && E2E_BASE_URL=http://localhost:3900 npm run test:api
```

CI runs the API suite on every PR (`.github/workflows/e2e-api.yml`). See `e2e/README.md` for the
browser suite, the compose `test` profile (browser-remote/CDP), and the opt-in worker-lifecycle
project.
