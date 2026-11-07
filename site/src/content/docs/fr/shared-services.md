---
title: "Services partagés"
description: "Lancer Postgres, Redis, Elasticsearch… une seule fois, et les joindre par leur nom depuis chaque espace de travail de chaque projet."
group: use
order: 5
---

Plutôt que chaque projet démarre son propre Elasticsearch, déclarez-en un — une fois — et chaque
worker de chaque projet le joint **par DNS, à son nom**. Un service est durable et indépendant : il
a ses propres démarrage, arrêt, redémarrage et logs, et il survit aux workers, et aux projets, qui
l’utilisent.

## En déclarer un

**Services** dans la barre latérale, puis un préréglage ou un formulaire vierge. Un service, c’est :

- un **slug** — son nom DNS (`postgres`) ;
- une **image** et son tag, et éventuellement une commande de remplacement ;
- des **variables d’environnement** — valeurs littérales, ou
  [références à des secrets globaux](/fr/docs/secrets#secrets-des-services-partagés) ;
- des **ports**, dont l’un peut être marqué comme son port HTTP ;
- des **volumes persistants**, nommés, avec leur point de montage ;
- une **politique de redémarrage** (`unless-stopped` par défaut).

Les préréglages remplissent le formulaire pour **Postgres**, **MySQL**, **Redis**,
**Elasticsearch**, **Kibana**, **MinIO** et **Mailpit**. Il y a un conteneur par service : une pile
se compose de plusieurs services — Elasticsearch *et* Kibana, ce dernier pointant vers
`http://elasticsearch:9200`, ce que font exactement les deux préréglages.

## Le joindre depuis un espace de travail

Chaque conteneur de service rejoint un réseau Docker partagé (`mp-shared-net`) sous son slug, et
chaque worker le rejoint à sa création. Ainsi, depuis n’importe quel espace de travail :

```bash
psql -h postgres -U postgres
curl http://elasticsearch:9200
redis-cli -h redis
```

Chaque worker reçoit aussi l’adresse dans son environnement, pour que rien n’ait à la coder en
dur :

```bash
SPUNTO_SERVICES=elasticsearch,postgres
SPUNTO_SVC_ELASTICSEARCH=http://elasticsearch:9200
SPUNTO_SVC_ELASTICSEARCH_HOST=elasticsearch
SPUNTO_SVC_ELASTICSEARCH_PORT=9200
SPUNTO_SVC_POSTGRES=postgres:5432
SPUNTO_SVC_POSTGRES_HOST=postgres
SPUNTO_SVC_POSTGRES_PORT=5432
```

- `SPUNTO_SVC_<SLUG>` est une URL `http://` complète seulement quand le service déclare un port
  HTTP ; sinon, c’est `host:port`.
- Le slug est mis en majuscules, et les tirets deviennent des underscores (`opensearch-dev` →
  `SPUNTO_SVC_OPENSEARCH_DEV`).
- Seuls les services démarrés sont listés.
- Le nom DNS fonctionne immédiatement depuis chaque worker ; les **variables** sont définies à la
  création d’un worker : un service déclaré plus tard n’y apparaît qu’après un **Rebuild**.

Un secret du même nom l’emporte sur une variable `SPUNTO_SVC_*`.

## Dans le navigateur

Un service doté d’un port HTTP se consulte via le proxy de Lite lui-même, sans rien publier sur
l’hôte :

| Hôte | Mène à |
|---|---|
| `http://svc-<slug>.localhost` | le port HTTP du service |
| `http://svc-<slug>-<port>.localhost` | ce port du conteneur (une console MinIO à côté de son API) |

Publier un port sur l’hôte reste possible, port par port (« on host » dans le formulaire) — pour un
`psql` ou un `redis-cli` lancé hors de tout conteneur.

## Cycle de vie

- **Modifier recrée** le conteneur — image, variables, ports et volumes sont fixés à la création.
  Ses volumes nommés sont **conservés** : les données survivent. Un service arrêté reste arrêté.
- Les **volumes** sont nommés `mp-svc-<serviceId>-<name>`, si bien que renommer un slug n’orpheline
  jamais de données. Ils apparaissent sur la page **Resources**.
- **Supprimer un service supprime ses volumes.** C’est définitif, et la confirmation le dit.
- Un conteneur qui meurt de lui-même apparaît en `error`, avec le message du démon et son code de
  sortie — à distinguer d’un service que vous avez arrêté.
- La carte affiche le CPU et la mémoire en direct ; **Logs** suit les logs du conteneur.

## Pourquoi un seul réseau partagé

Rattacher chaque service au réseau propre de chaque worker isolerait mieux, au prix d’une
connexion / déconnexion pour chaque paire à chaque lancement. Sur une machine mono-utilisateur, il
n’y a rien dont s’isoler : chaque worker est à vous, et les services sont déclarés précisément pour
être partagés.
