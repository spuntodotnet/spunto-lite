# Shared services — "Ship", local edition

Spunto's **Ship** pillar deploys services. Its point in Spunto Lite isn't
production: it's **mutualising heavy dependencies on your own machine**. Instead of
every project booting its own Elasticsearch, you declare one — in the control
plane — and every worker of every project reaches it by name.

A service is:

- **global** — no `projectId`. Sharing is the whole point. (A "which projects may
  see it" field can come later; nothing in the model forbids it.)
- **long-lived and independent** — start / stop / restart / logs of its own. It
  survives the deletion of a worker, and of a project.
- **reachable by DNS from every worker** — at its slug, on a shared bridge network.

## The one screen

**Services** in the sidebar. Per service: a slug, an image + tag, a command
override, environment variables, ports, persistent named volumes, a restart
policy. Presets prefill the form for Postgres, MySQL, Redis, Elasticsearch,
Kibana, MinIO and Mailpit.

**v1 is one container per service.** No `docker-compose.yml` import: a stack is
declared as several services on the same network — Elasticsearch *and* Kibana, the
latter pointing at `http://elasticsearch:9200`, which is exactly what the two
presets do. Compose import stays a possible evolution, not a prerequisite.

## Reachability — the mechanism

Each worker keeps its own bridge network `mp-worker-<id>-net` (created at spawn,
destroyed with it; the control plane joins it to reverse-proxy code-server). On top
of that there is now **one shared bridge, `mp-shared-net`**, created on demand:

- every **service** container is created *on* it, with a DNS alias equal to its slug;
- every **worker** container joins it at spawn (`network.connect()` right after
  `createContainer`, before `start` — so the shared names resolve from the first
  line of the setup script), under the alias `worker-<id>`;
- the **control plane** joins it the first time it has to proxy a service.

Result, from any worker:

```bash
curl http://elasticsearch:9200      # works
psql -h postgres -U postgres        # works
```

`mp-shared-net` is never removed. Unlike a worker network, no single deletion owns
it: `removeContainerOnly()` still tears down `mp-worker-<id>-net` and deliberately
leaves the shared one alone.

### Why one common network rather than N per-worker attachments

The alternative was to attach each service to **each worker's own** network. It
isolates better — you would pick which worker sees what — but it costs a
connect/disconnect for every `(worker, service)` pair, replayed on every spawn
*and* on every service creation or deletion, with the bookkeeping that implies. On
a single-user local machine there is nothing to isolate from: every worker is
yours, and the services are declared precisely to be shared. One common bridge is
simpler, has a single failure mode, and is enough. Per-project scoping, if the need
appears, is a filter on top of this — not a different network topology.

## Discoverability — the injected variables

At spawn, each worker receives one line per service that's meant to be up, so a
project reads its dependency's address from the environment instead of hard-coding
it:

```
SPUNTO_SERVICES=elasticsearch,postgres
SPUNTO_SVC_ELASTICSEARCH=http://elasticsearch:9200
SPUNTO_SVC_ELASTICSEARCH_HOST=elasticsearch
SPUNTO_SVC_ELASTICSEARCH_PORT=9200
SPUNTO_SVC_POSTGRES=postgres:5432
SPUNTO_SVC_POSTGRES_HOST=postgres
SPUNTO_SVC_POSTGRES_PORT=5432
```

- `SPUNTO_SVC_<SLUG>` is a full `http://` URL **only** when the service declares an
  HTTP port; otherwise it's `host:port`, because pretending Postgres speaks HTTP
  would be a lie. `_HOST` / `_PORT` are there for the many clients that take them
  separately.
- The slug is uppercased with hyphens turned into underscores
  (`opensearch-dev` → `SPUNTO_SVC_OPENSEARCH_DEV`).
- Only services in a non-stopped, non-error state are advertised: an unreachable
  name would only produce confusing connection errors.
- A worker picks up services declared *after* it was spawned on its next
  **rebuild** (its `/workspace` volume is kept). The DNS name works immediately;
  it's the variable that's baked in at creation.

Secrets of the same name still win: the `SPUNTO_SVC_*` block is injected *before*
the global/project secrets.

## Browser access, without publishing a host port

The reverse proxy that already serves `worker-<id>[-<port>].<BASE_DOMAIN>` now also
serves:

| Host | Goes to |
|---|---|
| `svc-<slug>.<BASE_DOMAIN>` | the service's **HTTP port** |
| `svc-<slug>-<port>.<BASE_DOMAIN>` | that container port (a MinIO console next to its API) |

So a Kibana or a MinIO console is one click from the Services page — no `-p` on the
host, no port collision with whatever you already run. The whole label is tried as
a slug **first**, so a service literally named `postgres-15` still resolves; only
then is a trailing `-<digits>` read as an explicit port.

Publishing on the host stays available and opt-in, per port ("on host" in the
form) — for a `psql` or a `redis-cli` run outside any container.

## Secrets

An environment variable is either a **literal value** — stored as-is in SQLite,
which is the honest default for a local single-user tool (`discovery.type`,
`POSTGRES_DB`) — or a **reference to a global secret** by name. In the second form
nothing sensitive is stored on the service: the AES-GCM encrypted value is
decrypted only when the container is created. Put anything that matters in
**Global secrets** and reference it.

A reference to a secret that no longer exists is **dropped with a warning** rather
than injected as an empty string, which would silently mean "no password".

## Lifecycle details worth knowing

- **Editing recreates.** Image, command, env, ports, volumes, restart policy and
  the DNS alias are all baked into the container at creation, so saving an edit
  removes and recreates it. Its **named volumes are kept** — the data survives.
  A stopped service stays stopped; the new spec applies on its next start.
- **Volumes are keyed on the service id**: `mp-svc-<serviceId>-<name>`, so renaming
  a slug never orphans data. They show up on the **Resources** page as
  `kind: "service"`, next to the worker volumes.
- **Deleting a service deletes its volumes.** That one is permanent, and the
  confirmation says so.
- **A crash is told apart from a stop.** Stopping writes the state *before* the
  container goes down, so a non-zero exit code afterwards is the SIGTERM the image
  chose to report — not a failure. A container that dies on its own surfaces as
  `error`, with the daemon's message and its exit code on the card.

## Where the code lives

| Concern | File |
|---|---|
| Shared network, service containers | `lib/docker.ts` (`SHARED_NETWORK_NAME`, `connectToSharedNetwork`, `spawnServiceContainer`) |
| Service domain logic | `services/services.ts` |
| Variables injected into workers | `services/services.ts` `serviceEnvForWorkers()` → `services/workers.ts` `spawnEnv()` |
| `svc-<slug>` routing | `server/worker-proxy.ts` (`parseProxyHost`, `resolveServiceRoute`) |
| Table + migration | `db/schema.ts` (`services`), `drizzle/0004_*.sql` |
| Presets | `lib/service-catalog.ts` |
| UI | `app/(app)/services/page.tsx`, `components/service-card.tsx`, `components/service-form.tsx` |
| Tests | `e2e/tests/services.spec.ts`, `services-ui.spec.ts`, `shared-service-reach.spec.ts` (opt-in, real Docker) |
