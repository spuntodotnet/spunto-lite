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
`http://worker-<id>-<port>.localhost` (forwarded ports); shared services at
`http://svc-<slug>.localhost`. `*.localhost` resolves to `127.0.0.1`
automatically in Chrome/Edge/Firefox.

## How it works

- **One Next.js app** (App Router) served by a small custom Node server
  (`server.ts`) that also reverse-proxies worker subdomains and hosts the
  terminal WebSocket.
- **`dockerode`** → `/var/run/docker.sock`: workers are sibling containers on the
  host daemon.
- **SQLite** (via Drizzle) for projects/workers/secrets, in a Docker volume.
- **`~/.ssh` mounted read-only** and injected into each worker for git identity.
- **Shared services** — the local take on Spunto's *Ship* pillar. Declare a
  long-lived dependency once (Postgres, Elasticsearch, MinIO… image + env + ports
  + persistent volumes, presets included) under **Services**, and **every worker of
  every project reaches it by DNS at its slug**: one instance instead of one per
  project. Each service container joins a shared bridge `mp-shared-net` under its
  slug, every worker joins it at spawn, so `curl http://elasticsearch:9200` works
  from any workspace. Its address is also injected at spawn as
  `SPUNTO_SVC_<SLUG>` (plus `_HOST`/`_PORT`) so nothing hard-codes an URL, and a
  service with an HTTP port is browsable at `http://svc-<slug>.localhost` through
  the same reverse proxy as the workers — no host port to publish. Env vars can
  reference an encrypted **global secret** by name instead of holding a literal
  value. Lifecycle is its own (start/stop/restart/logs, live CPU/RAM): a service
  outlives the worker, and the project, that needed it. Details and the
  network-design trade-off: [`docs/shared-services.md`](docs/shared-services.md).
- **Shared volumes**: a project can declare volumes mounted into **every** worker
  it spawns, on top of each worker's private `/workspace` — a pnpm store, `~/.m2`,
  a `~/.cache`, a heavy dataset, a build-artifact directory. See below.
- **Projects are portable**: *Export* on a project downloads its spec as JSON
  (`GET /api/projects/:id/export`), *Import* on the dashboard (or in the
  new-project form) pre-fills the creation form from such a file. Secret
  **values** are never exported — only their names, so the form can lay out the
  rows to fill in.
- **Extension registry is configurable**: the extension picker searches
  [Open VSX](https://open-vsx.org) by default. Set `EXTENSIONS_GALLERY` on the
  control plane — the same JSON blob code-server takes — and the picker, the
  `--install-extension` calls in the image build *and* the code-server inside
  every worker all switch to that gallery together, so what you can find stays
  what you can install:
  ```bash
  docker run -d --name spunto-lite -p 80:80 \
    -e EXTENSIONS_GALLERY='{"serviceUrl":"https://gallery.example.com/_apis/public/gallery","itemUrl":"https://gallery.example.com/items"}' \
    … ghcr.io/spuntodotnet/spunto-lite:latest
  ```
  Add an optional `"productTarget"` key when the gallery serves more than one
  product's catalog and you want results scoped to the editor's. Project images
  are cached per version, so **rebuild** a project for its pre-installed
  extensions to be re-resolved against a gallery you just changed. Which gallery
  you point this at, and under which terms, is yours to decide.
- **⌘K search** (Ctrl+K on non-Apple): the header palette
  (`CommandPalette` from `@spunto/design-system`) jumps to projects, workers, the
  shared services *and* the ones a worker exposes (code-server + forwarded ports),
  image builds, secret *names* and project templates — plus the nav and a couple of
  actions. It pulls
  the whole index from `GET /api/search` when it opens (SQLite only, no Docker
  round-trip, so it's instant) and filters in the browser, accent- and
  case-insensitively.

## Shared volumes

Each worker gets its own `mp-worker-<id>-workspace` volume on `/workspace`. Two
workers of the same project therefore re-download their dependencies and
regenerate their artifacts separately. A project can declare **shared volumes**
in the *Shared volumes* section of the project form (under the advanced fold) to
stop that: a name and a mount path, e.g. `pnpm-store` →
`/home/vscode/.local/share/pnpm/store`.

- Backed by a named Docker volume `mp-proj-<projectId>-<name>`, **created on
  demand** by the first worker that needs it and reused by every later one.
- Mounted in **every** worker of the project, alongside its private `/workspace`.
- **Lifecycle**: survives deleting a worker and rebuilding one (unlike
  `mp-worker-*` volumes, which a delete wipes). It's destroyed **only** with the
  project, behind an explicit confirmation in the delete dialog — your data
  lives in there.
- Visible on the **Resources** page with `kind: "shared"`, its owning project,
  its size and how many workspaces mount it.
- The declaration is versioned like the rest of the project config, so restoring
  a version and exporting/importing a project carry it. Only the declaration
  travels in an export — never the data.
- **`/workspace` and its sub-paths are refused** as mount points: they'd shadow
  the worker's own volume and break the setup script's idempotent clone. Same for
  `/var/lib/docker`, `/var/lib/containerd` and the kernel filesystems.

> **Concurrency is not managed.** Several workers write into the same volume at
> the same time and **nothing locks**. That's fine for what this is for — package
> caches, datasets, fixtures, build artifacts, read-mostly data. It is *not* a
> place for a shared SQLite database, a lockfile two processes rewrite, or
> anything needing a single writer.

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

## License

[MIT](LICENSE) — fork it, run it commercially, vendor pieces of it; just keep the
copyright notice.
