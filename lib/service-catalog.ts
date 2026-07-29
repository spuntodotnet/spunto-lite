import type { ServiceEnvVar, ServicePort, ServiceVolume } from "./types"

// Ready-made specs for the dependencies people actually mutualise on a dev machine.
// A preset is only a *prefill* of the service form — nothing is resolved server-side,
// so anything here can be edited before it's created, and a service that isn't in
// this list is created by filling the form by hand.
//
// Two conventions, both deliberate:
//
//  * **No host port by default.** Workers reach a service by DNS on the shared
//    network (`postgres:5432`), so publishing on the machine is opt-in — it's the
//    thing that collides with a Postgres already running on the host.
//  * **Passwords are literal placeholders.** They're stored in clear in SQLite, which
//    is the honest default for a local single-user tool; swap any of them for a
//    reference to a Global secret in the form when it matters.

export type ServicePreset = {
  id: string
  label: string
  description: string
  slug: string
  image: string
  command?: string
  env?: ServiceEnvVar[]
  ports?: ServicePort[]
  volumes?: ServiceVolume[]
  httpPort?: number
}

export const SERVICE_PRESETS: ServicePreset[] = [
  {
    id: "postgres",
    label: "PostgreSQL 16",
    description: "Relational database, data on a persistent volume",
    slug: "postgres",
    image: "postgres:16-alpine",
    env: [
      { name: "POSTGRES_USER", value: "postgres" },
      { name: "POSTGRES_PASSWORD", value: "postgres" },
      { name: "POSTGRES_DB", value: "postgres" },
    ],
    ports: [{ container: 5432 }],
    volumes: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
  },
  {
    id: "mysql",
    label: "MySQL 8",
    description: "Relational database, data on a persistent volume",
    slug: "mysql",
    image: "mysql:8",
    env: [{ name: "MYSQL_ROOT_PASSWORD", value: "mysql" }],
    ports: [{ container: 3306 }],
    volumes: [{ name: "data", mountPath: "/var/lib/mysql" }],
  },
  {
    id: "redis",
    label: "Redis 7",
    description: "In-memory store, append-only file persisted",
    slug: "redis",
    image: "redis:7-alpine",
    command: "redis-server --appendonly yes",
    ports: [{ container: 6379 }],
    volumes: [{ name: "data", mountPath: "/data" }],
  },
  {
    id: "elasticsearch",
    label: "Elasticsearch 8",
    description: "Single-node, security off — the heavy one worth sharing",
    slug: "elasticsearch",
    image: "docker.elastic.co/elasticsearch/elasticsearch:8.13.4",
    env: [
      { name: "discovery.type", value: "single-node" },
      { name: "xpack.security.enabled", value: "false" },
      { name: "ES_JAVA_OPTS", value: "-Xms512m -Xmx512m" },
    ],
    ports: [{ container: 9200 }],
    volumes: [{ name: "data", mountPath: "/usr/share/elasticsearch/data" }],
    httpPort: 9200,
  },
  {
    id: "kibana",
    label: "Kibana 8",
    description: "Front-end for the `elasticsearch` service — declare both",
    slug: "kibana",
    image: "docker.elastic.co/kibana/kibana:8.13.4",
    env: [{ name: "ELASTICSEARCH_HOSTS", value: "http://elasticsearch:9200" }],
    ports: [{ container: 5601 }],
    httpPort: 5601,
  },
  {
    id: "minio",
    label: "MinIO",
    description: "S3-compatible object storage, console on 9001",
    slug: "minio",
    image: "minio/minio:latest",
    command: "server /data --console-address :9001",
    env: [
      { name: "MINIO_ROOT_USER", value: "minioadmin" },
      { name: "MINIO_ROOT_PASSWORD", value: "minioadmin" },
    ],
    ports: [{ container: 9000 }, { container: 9001 }],
    volumes: [{ name: "data", mountPath: "/data" }],
    httpPort: 9000,
  },
  {
    id: "mailpit",
    label: "Mailpit",
    description: "SMTP sink + web inbox, for anything that sends mail",
    slug: "mailpit",
    image: "axllent/mailpit:latest",
    ports: [{ container: 1025 }, { container: 8025 }],
    httpPort: 8025,
  },
]
