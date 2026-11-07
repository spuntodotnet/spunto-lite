---
title: Shared services
description: Run Postgres, Redis, Elasticsearch… once, and reach them by name from every workspace of every project.
group: use
order: 5
---

Instead of every project booting its own Elasticsearch, declare one — once — and every worker of
every project reaches it **by DNS, at its name**. A service is long-lived and independent: it has
its own start, stop, restart and logs, and it outlives the workers, and the projects, that use it.

## Declaring one

**Services** in the sidebar, then a preset or a blank form. A service is:

- a **slug** — its DNS name (`postgres`);
- an **image** and tag, and optionally a command override;
- **environment variables** — literal values, or [references to global secrets](/docs/secrets#secrets-in-shared-services);
- **ports**, one of which can be marked as its HTTP port;
- **persistent volumes**, named, with their mount path;
- a **restart policy** (`unless-stopped` by default).

Presets fill the form for **Postgres**, **MySQL**, **Redis**, **Elasticsearch**, **Kibana**,
**MinIO** and **Mailpit**. There is one container per service: a stack is several services —
Elasticsearch *and* Kibana, the latter pointing at `http://elasticsearch:9200`, which is exactly
what the two presets do.

## Reaching it from a workspace

Every service container joins a shared Docker network (`mp-shared-net`) under its slug, and every
worker joins it when it is created. So, from any workspace:

```bash
psql -h postgres -U postgres
curl http://elasticsearch:9200
redis-cli -h redis
```

Each worker also gets the address in its environment, so nothing has to hard-code it:

```bash
SPUNTO_SERVICES=elasticsearch,postgres
SPUNTO_SVC_ELASTICSEARCH=http://elasticsearch:9200
SPUNTO_SVC_ELASTICSEARCH_HOST=elasticsearch
SPUNTO_SVC_ELASTICSEARCH_PORT=9200
SPUNTO_SVC_POSTGRES=postgres:5432
SPUNTO_SVC_POSTGRES_HOST=postgres
SPUNTO_SVC_POSTGRES_PORT=5432
```

- `SPUNTO_SVC_<SLUG>` is a full `http://` URL only when the service declares an HTTP port;
  otherwise it is `host:port`.
- The slug is uppercased, hyphens become underscores (`opensearch-dev` →
  `SPUNTO_SVC_OPENSEARCH_DEV`).
- Only services that are up are listed.
- The DNS name works at once from every worker; the **variables** are set when a worker is created,
  so a service declared later shows up in them after a **Rebuild**.

A secret of the same name wins over a `SPUNTO_SVC_*` variable.

## In the browser

A service with an HTTP port is browsable through Lite's own proxy, without publishing anything on
the host:

| Host | Goes to |
|---|---|
| `http://svc-<slug>.localhost` | the service's HTTP port |
| `http://svc-<slug>-<port>.localhost` | that container port (a MinIO console next to its API) |

Publishing a port on the host stays possible, per port ("on host" in the form) — for a `psql` or a
`redis-cli` run outside any container.

## Lifecycle

- **Editing recreates** the container — image, env, ports and volumes are fixed at creation. Its
  named volumes are **kept**, so the data survives. A stopped service stays stopped.
- **Volumes** are named `mp-svc-<serviceId>-<name>`, so renaming a slug never orphans data. They
  appear on the **Resources** page.
- **Deleting a service deletes its volumes.** That is permanent, and the confirmation says so.
- A container that dies on its own shows as `error`, with the daemon's message and its exit code —
  distinct from one you stopped.
- The card shows live CPU and memory; **Logs** tails the container.

## Why one shared network

Attaching each service to each worker's own network would isolate better, at the cost of a
connect/disconnect for every pair on every spawn. On a single-user machine there is nothing to
isolate from: every worker is yours, and services are declared precisely to be shared.
