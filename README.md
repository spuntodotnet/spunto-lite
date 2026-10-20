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
docker compose up -d --build  # or ./start.sh, which does the same
```

Or run the pre-built image straight from GHCR:

```bash
docker run -d --name spunto-lite -p 80:80 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.ssh:/host-ssh:ro" \
  -v spunto-lite-ssh-agent:/run/spunto-ssh-agent \
  -v spunto-lite-data:/app/data \
  ghcr.io/spuntodotnet/spunto-lite:latest
```

Then open **http://localhost**. Workers appear at
`http://worker-<id>.localhost` (VS Code) and
`http://worker-<id>-<port>.localhost` (forwarded ports); shared services at
`http://svc-<slug>.localhost`. `*.localhost` resolves to `127.0.0.1`
automatically in Chrome/Edge/Firefox.

That works from *your* browser. From a container — `browser-remote`, the e2e
runner — `localhost` is the container itself, so the same stack also answers on a
real wildcard domain (`*.local.spunto.net`) served by a bundled CoreDNS, over
HTTPS with a local mkcert certificate. See
[`docs/local-domain.md`](docs/local-domain.md).

## How it works

- **One Next.js app** (App Router) served by a small custom Node server
  (`server.ts`) that also reverse-proxies worker subdomains and hosts the
  terminal WebSocket.
- **`dockerode`** → `/var/run/docker.sock`: workers are sibling containers on the
  host daemon — for their *lifecycle* only (create, start, stop, remove, build).
- **Each worker carries an agent** — the very one a Spunto Cloud sandbox runs, from
  `@spunto/build`. The container's main process is its bootstrap; the agent dials back over a
  WebSocket and carries everything inside the box: commands, terminals, listening ports, the
  setup's progress. No `docker exec`, no Node download (Lite lends its own through a read-only
  volume). Workers created by an older Lite keep `docker exec` until rebuilt. See
  [`docs/agent.md`](docs/agent.md).
- **SQLite** (via Drizzle) for projects/workers/secrets, in a Docker volume.
- **`~/.ssh` mounted read-only** and injected into each worker — it is both the git
  identity and the *only* clone credential. A repository is declared as a **clone
  URL**, never as a host plus an `owner/repo`: there is no forge integration here,
  no app to install and no token to mint, so any host your key reaches works the
  same way — a hosted forge, a self-hosted GitLab, a bare repo on a NAS. Authorize
  the key once, wherever, and every project clones and pushes. A key protected by a
  passphrase works too, through an SSH agent — see
  [SSH keys with a passphrase](#ssh-keys-with-a-passphrase).
- **[`@spunto/build`](https://www.npmjs.com/package/@spunto/build)** for everything
  the two Spuntos have to agree on: the image recipe and the shell it generates, the
  build-log protocol, the extension-registry clients, the Docker naming scheme and the
  portable project format. Same idea as `@spunto/design-system`, one layer down — that
  one owns what the products look like, this one what they agree on. A workspace image
  is your base image plus two devcontainer features,
  [`common-utils`](https://github.com/devcontainers/features/tree/main/src/common-utils)
  then [`spunto-pack`](https://github.com/coderhammer/features/tree/main/src/spunto-pack),
  before the features the project declares; images are tagged
  `mp-proj-<id>:v<version>-r<recipe>`, so a release that changes what goes into an image
  rebuilds it instead of leaving your workers on the old one. What the two Spuntos share
  today and what they still duplicate — project creation, worker listing, the status
  vocabularies — is written down in [`docs/api-partagee.md`](docs/api-partagee.md).
- **A persistent terminal on dtach**, not a multiplexer. Closing the tab does not kill
  the build: the worker's agent attaches to a session that outlives it. dtach only
  does persistence and forwards every byte, so the *browser* keeps the mouse, the
  scrollback and the search — with tmux, the only way to make the wheel scroll history is
  `mouse on`, which also swallows every drag and takes text selection with it. What dtach
  does not do is remember the screen, so each session is recorded container-side with
  `script(1)` and the tail replayed on attach.
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

## Agents

Delegate work to a coding agent the way Spunto Cloud does: **New task** on a project (or
**Agents** in the sidebar), write what you want, and a worker from the project's pool gets its own
branch and a Claude Code session. You watch it work live, answer it or interrupt it, read the diff
from the machine itself, open a shell on it from the **Terminal** tab, then **Accept** or **Drop**. Every conversation of every project is on
the **Agents** page, grouped by what needs you.

Out of the box it runs Claude Code, so the project needs the `claude-code` feature and an
`ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) secret. The harness, the model, what Accept
and Drop run and whether the worker stays up during review are the project's *Delegated work*
settings. The screens come from `@spunto/design-system/tasks` and the session parsing from
`@spunto/build/agent-stream`, shared with Spunto Cloud. Details, and what differs from the Cloud
version: [`docs/taches.md`](docs/taches.md).

## Shared volumes

Each worker gets its own `mp-worker-<id>-workspace` volume on `/workspace`. Two
workers of the same project therefore re-download their dependencies and
regenerate their artifacts separately. A project can declare **shared volumes**
in the *Shared volumes* section of the project form (inside *Advanced options*)
to stop that: a name and a mount path, e.g. `pnpm-store` →
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

## SSH keys with a passphrase

A key without passphrase is copied into each worker and used as is. A key **with** a
passphrase is copied too — still encrypted — but ssh can't ask for its passphrase in
a worker (no terminal behind `git clone`, nor behind a `git push` run by an agent), so
it signs through an **SSH agent** instead. Settings marks such a key with a
*passphrase* badge, and a banner says so on every page as long as nothing can use it.
Two ways to give it an agent:

1. **Unlock it in Settings** (works everywhere, nothing to configure). Type the
   passphrase once: Spunto Lite loads the key into its own `ssh-agent` and drops the
   passphrase — it is never written to disk, never stored in the database, never
   logged. The decrypted key lives only in that agent's memory, so after a restart of
   Spunto Lite the key is locked again and the banner asks for the passphrase. *Lock*
   forgets it at once.
2. **Forward your host's agent**, if you already `ssh-add` the key on your machine
   (keychain, 1Password, `gpg-agent`…). Mount it into the Spunto Lite container at
   `/run/host-services/ssh-auth.sock` — uncomment the matching line of
   `docker-compose.yml`, or add to `docker run`:

   ```bash
   # macOS — Docker Desktop's own forwarded agent (the launchd socket in $SSH_AUTH_SOCK
   # can't be bind-mounted from macOS):
   -v /run/host-services/ssh-auth.sock:/run/host-services/ssh-auth.sock
   # Linux:
   -v "$SSH_AUTH_SOCK:/run/host-services/ssh-auth.sock"
   ```

   On Linux the path of `$SSH_AUTH_SOCK` changes with each login session: recreate the
   container after logging in again. Settings shows whether the host agent holds the
   selected key. A key unlocked in Settings takes precedence over the host agent.

How it reaches the workers: every worker mounts the `spunto-lite-ssh-agent` volume and
gets `SSH_AUTH_SOCK=/run/spunto-ssh-agent/agent.sock`, a socket served by Spunto Lite
that forwards to whichever agent holds the key (a named volume because Docker Desktop
can't carry a Unix socket through a bind-mounted host directory). The socket is always
there, so unlocking a key reaches the workers that are already running — except those
created before this volume existed, which need a **Rebuild**. Without the volume
mounted on the Spunto Lite container, Settings says so: keys without a passphrase keep
working, keys with one don't.

> Like any agent forwarding, whatever runs in a worker can ask the agent to sign
> while the key is unlocked — it can't read the key itself.

Override the paths with `SSH_AGENT_DIR` (default `/run/spunto-ssh-agent`) and
`HOST_SSH_AUTH_SOCK` (default `/run/host-services/ssh-auth.sock`).

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
