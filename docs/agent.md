# L'agent d'un worker

Un worker créé par cette version **porte un agent**. C'est le même que celui d'une sandbox de
Spunto Cloud, servi depuis le même paquet (`@spunto/build/sandbox-agent`,
[RFC 0047](https://github.com/coderhammer/spunto/blob/main/rfc/0047-l-agent-embarque-dans-spunto-build.md)).
Le processus principal du conteneur est `bootstrap.sh`, qui lance `agent.mjs`. L'agent rappelle
Lite en WebSocket et porte ensuite **tout ce qui se passe dans la boîte** :
- les commandes (celles des tâches comprises) ;
- les terminaux ;
- les ports qui écoutent ;
- l'état du setup.

Docker ne sert plus qu'au **cycle de vie** : créer, démarrer, arrêter, supprimer, construire
l'image. code-server, lui, reste joint par le proxy sur l'IP du conteneur.

```
Lite (server.ts) ── docker create/start ──► conteneur : sh bootstrap.sh → node agent.mjs
      ▲                                                            │
      └──────────── ws://spunto-lite/api/agent/connect ◄───────────┘
           hello + jeton → welcome → plan du projet → exec / term_* / ports / project_state
```

## Pourquoi

Avant, Lite faisait tout en `docker exec`, et chaque correctif du plan de données des sandboxes
était à reporter ici. En passant par l'agent, Lite récupère ces correctifs par une simple montée
de version du paquet :
- le collage de plus de 4 Ko qui tuait une session dtach (`script(1)` entre dtach et le shell) ;
- l'environnement des features capturé pour les commandes lancées par `su` (`BASH_ENV`) ;
- le replay d'un terminal au rattachement ;
- la phase `running`, qui attend la fin du postStart *de ce démarrage*.

## Les morceaux

| Quoi | Où |
|---|---|
| L'agent, son bootstrap, son runner | `@spunto/build/sandbox-agent`, servis par `GET /api/agent/agent.mjs` et `GET /api/agent/bootstrap.sh` |
| Le fil (messages, codes, cadences) | `@spunto/build/agent-protocol` |
| La moitié serveur d'une connexion (execs, terminaux, tunnels en attente) | `@spunto/build/agent-connection`, enregistrée par `lib/agent.ts` |
| Les scripts des commandes de fond | `@spunto/build/commands`, les mêmes que Cloud |
| Hello → worker, plan, état poussé | `services/workers.ts` (`planFor`, `applyProjectState`) |

**Le jeton** est propre à chaque worker. Il est donné au conteneur (`SPUNTO_SANDBOX_TOKEN`), et
l'agent le retire de l'environnement des commandes qu'il lance. Lite n'en garde que le SHA-256
(`workers.agent_token_hash`). Un Rebuild en tire un nouveau.

**Le plan** est renvoyé à chaque hello : la recette, le script worker et le runner. Le script
worker est **reconstruit à ce moment-là**, avec les secrets, la clé SSH et les réglages du moment.
Comme avant, le setup ne rejoue qu'une fois (`~/.mp-setup-done`) et le start à chaque démarrage.

**L'état** est poussé par l'agent (`project_state`) au lieu d'être lu par `docker exec`. Le
contenu de `setupStatus` reste celui de `~/.mp-status.json`, comme avant :
- `running` → `ready` ;
- runner sorti en erreur → `error`, avec la fin de son log ;
- sinon → `starting`.

Un arrêt en cours n'est jamais écrasé : l'agent peut encore parler pendant les secondes que prend
`docker stop`.

## L'image : cuite par le runner

Le build passe la recette par le **runner de l'agent**, en mode `bake-only` (`buildRecipeScript`),
au lieu de la jouer telle quelle. L'image garde ainsi :
- le marqueur `.baked-<clé>` dans `/opt/spunto-sandbox/project/` ;
- l'environnement des features (`/etc/profile.d/spunto-features.sh`).

La clé est posée en label (`spunto.bakeKey`). Au démarrage, l'agent trouve le marqueur et passe
directement au script worker, sans rien recuire. C'est le contrat des builds d'apps de Cloud
(RFC 0042). Le tag de l'image porte un `-a1` : une image d'avant n'a pas le marqueur et n'est donc
pas réutilisée.

## Node : rien n'est téléchargé

L'agent veut un Node ≥ 22. Un volume nommé, `spunto-lite-agent`, monté en lecture seule sur
`/opt/spunto-agent` dans chaque worker, contient :
- **le bootstrap** (`bootstrap-<hash>.sh`) ;
- **le Node de Lite lui-même** (`node-<version>-<arch>/bin/node`), passé à l'agent par `SPUNTO_NODE`.

Le volume est rempli par un conteneur créé et jamais démarré (`putArchive`). **Un fichier n'y est
jamais réécrit**, les chemins changent avec le contenu : un worker exécute ces fichiers *depuis*
le volume, et on ne remplace pas un exécutable qui tourne (`ETXTBSY`), pas plus qu'un script que
`sh` lit au fil de l'eau.

Si Lite ne tourne pas sous Linux (sur l'hôte d'un Mac), il n'y a pas de Node dans le volume : le
bootstrap télécharge le binaire officiel, ce qui demande glibc et le réseau. Une image musl
(Alpine) ne peut faire tourner ni ce Node ni code-server.

## L'adresse de Lite vue d'un worker

- **Lite dans un conteneur** : il rejoint le réseau partagé des workers sous l'alias `spunto-lite`,
  et l'agent appelle `http://spunto-lite:<PORT>`. Il le rejoint au boot, à chaque création de
  worker et avant chaque Start : un conteneur Lite recréé (une mise à jour) n'y est plus, et sans
  ça un worker redémarré, comme les agents des workers qui tournent, ne le trouvent plus.
- **Lite sur l'hôte** : l'agent appelle `http://host.docker.internal:<PORT>`. Chaque worker reçoit
  `host-gateway` pour cette adresse.
- **`LITE_INTERNAL_URL`** remplace les deux.

## Les workers d'avant

`workers.data_plane` vaut `exec` pour tout worker créé avant cette version (c'est la valeur par
défaut de la colonne). Ces workers gardent le chemin `docker exec`, inchangé. **Un Rebuild les
fait passer à l'agent**. `WORKER_DATA_PLANE=exec` remet le comportement d'avant pour les workers
qu'on crée.

## Les limites connues

- Le terminal du dashboard ne se rattache pas tout seul après une coupure de l'agent (code
  `1012`). Celui de Cloud le fait. À reprendre dans `components/worker-terminal.tsx`.
- Un terminal ouvert avant que l'agent ait dit bonjour (les premières secondes d'un démarrage)
  reçoit « Worker agent is not connected yet ».
- Les **logs** d'un worker sont ceux du runner : la recette, les clones, postCreate et postStart.
  Ils sont lus par l'agent, parce que la sortie du conteneur lui-même est maintenant celle de
  l'agent.
