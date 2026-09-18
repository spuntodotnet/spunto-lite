# Les états d'un worker — et pourquoi ceux de Spunto Cloud ne sont pas les mêmes

> Analyse détaillée de la ligne « statuts » de [`api-partagee.md`](api-partagee.md).
> Comparé : `spunto-lite@24a2408` et `coderhammer/spunto@32167ea`.
> Le pendant côté Cloud est `docs/worker-states.md` (qui a deux états de retard, voir § 7).

Quatre valeurs sont communes sur dix. Mais compter les valeurs est la mauvaise façon de lire la
différence : **les deux produits ne font pas dire la même chose au mot « état »**. Cloud a deux axes
qui peuvent se contredire, Lite en a un seul recalculé à la lecture. Le vocabulaire n'est que la
conséquence visible de ça.

## 1. La liste, alignée sur ce qui se passe réellement

| Ce qui se passe | Lite | Cloud |
|---|---|---|
| Ligne insérée, rien n'a commencé | `pending` | `provisioning` |
| L'image du projet se construit | **`building`** | `provisioning` (le worker *attend* le build, qui est une ressource à part) |
| L'image arrive sur la machine cible | *(compris dans `building`)* | **`pulling`** |
| Conteneur créé, script de setup en cours | `starting` | `starting` |
| Setup terminé | `ready` | `ready` |
| Arrêt demandé, pas encore effectif | *(n/a — appel local, instantané)* | **`stopping`** |
| Arrêté | `stopped` | `stopped` |
| Suppression en cours | *(n/a — synchrone)* | **`deleting`** |
| Échec | `error` | `error` |

**Une seule cause explique les quatre états que Cloud a en plus.** Chez nous le socket Docker est
local : arrêter un conteneur, le supprimer, lui parler, c'est un appel de fonction. Chez Cloud le
conteneur est sur une autre machine, au bout d'un WebSocket JSON-RPC vers l'agent du node. Chaque
transition a donc une **durée**, pendant laquelle il faut bien dire quelque chose à l'utilisateur —
d'où `stopping`, `deleting`, `pulling`. Ce ne sont pas des états conceptuels de plus, ce sont des
allers-retours réseau qui ont reçu un nom.

`building` est la seule exception, et elle va dans l'autre sens : voir § 6.

## 2. L'axe qui compte : `state` réconcilié vs `state` + `dockerState`

C'est la vraie différence, et elle est invisible dans une table d'enums.

**Cloud a deux axes.** `state` est l'**intention** du plan de contrôle — le dernier événement de
cycle de vie qu'il a enregistré. `dockerState` (`running | stopped | exited | created | not_found |
error`) est l'**observation**, enrichie à la volée par un RPC vers l'agent, qui peut échouer tout
seul. Les deux peuvent se contredire, et **la contradiction est l'information** : `state: "ready"` +
`dockerState: "exited"` veut dire « le setup a réussi puis le conteneur est mort ». C'est écrit noir
sur blanc dans leur doc, et c'est la raison d'être du second champ.

**Lite a un axe.** `refreshWorker` (`services/workers.ts:285`) est appelé sur **chaque** lecture
(`listWorkersLive`, `getWorkerLive`) : il inspecte le conteneur, lit le fichier de statut dedans, en
déduit un `state` unique et l'écrit en base. Pas de désaccord possible — mais pas d'expressivité
non plus.

**Conséquence directe, et c'est un vrai manque fonctionnel : Lite ne sait pas distinguer « tu l'as
arrêté » de « il est mort ».** Un worker `ready` dont le conteneur part en OOM devient `stopped`,
exactement comme celui qu'on a arrêté au bouton. Le code le fait explicitement
(`services/workers.ts:294-313`) : `cState === "stopped"` et un état précédent qui n'est pas un état
de setup → `stopped`. Et un conteneur supprimé dans le dos de l'app (`not_found`) devient `stopped`
avec `containerId` remis à `null`, là où Cloud garderait `state: "ready"` + `dockerState:
"not_found"`.

Le plus frappant, c'est que **Lite a déjà résolu ce problème — pour les services, pas pour les
workers.** Dans le même fichier, une fonction plus haut :

```ts
/**
 * Live state of a service container. Richer than `getContainerState` because a
 * service that *died* has to be told apart from one that was stopped on purpose:
 * the exit code and the daemon's own error message are what the UI shows.
 */
export async function inspectServiceContainer(containerId: string)  // lib/docker.ts:503
```

`getContainerState` (`lib/docker.ts:525`), celle que les workers utilisent, jette l'`ExitCode` et le
`State.Error` que Docker donne pourtant dans le même `inspect()`. La distinction qu'on a jugée
indispensable pour un Postgres partagé, on ne la fait pas pour un workspace.

## 3. Push vs pull : qui écrit l'état

| | Lite | Cloud |
|---|---|---|
| Source | **pull**, à la lecture | **push**, par événements |
| Mécanique | `refreshWorker` sur chaque `GET` : `inspect` + `docker exec cat` du fichier de statut | l'agent pousse `pulling` / `started` / `setup_status` / `setup_ready` / `setup_error` / `stopped` en WebSocket ; `handleWorkerEvent` écrit en base (`modules/nodes/agent-registry.ts:1050`) |
| Spawn | `void runSpawnPipeline(...)` fire-and-forget (`services/workers.ts:217`) | job durable `worker.spawn` (RFC 0016), repris après un redéploiement |
| Réconciliation | aucune — rien ne tourne en fond | `recoverStuckBuilds`, `reconcileOrphanedSpawns`, `IN_FLIGHT_STATES` passés en `error` à la déconnexion du node |

Trois conséquences concrètes :

- **Une écriture en base par lecture.** Chaque `GET /api/projects/:id/workers` fait un `UPDATE` par
  worker. Sur un SQLite local, c'est sans importance ; c'est juste à savoir avant de mettre un
  `refetchInterval` agressif.
- **Aucun timeout n'est possible chez nous, et il n'y en a pas.** Un `postCreateCommand` qui attend
  sur stdin laisse le worker en `starting` pour toujours : il n'y a aucune horloge, parce qu'il n'y
  a aucun processus de fond. Cloud passe en `error` au bout de 30 minutes sans phase terminale.
  C'est le prix du modèle pull : rien ne se passe si personne ne regarde.
- **En échange, l'état n'est jamais périmé quand on le lit** — et il n'y a ni bus d'événements, ni
  job durable, ni réconciliation à écrire. Pour un plan de contrôle mono-machine c'est le bon
  échange, et ce n'est pas ça qu'il faut partager.

## 4. Chez nous, `state` est *dérivé* de `setupStatus`

Sur un conteneur qui tourne, Lite ne choisit pas son état, il le calcule
(`services/workers.ts:325`) :

```ts
const state = phase === "ready" ? "ready" : phase === "error" ? "error" : "starting"
```

Donc `state` et `setupStatus.phase` ne peuvent pas se contredire : le premier est une fonction du
second. Chez Cloud les deux champs sont écrits **ensemble mais séparément**, par des événements
distincts — et certains chemins n'en écrivent qu'un (un redémarrage écrit `state: "ready"` sans
toucher au `setupStatus`, `workers.service.ts:209`). Les deux modèles sont défendables ; ce qui
compte est qu'un client partagé ne peut pas supposer la relation de l'un chez l'autre.

## 5. `setupStatus` : le seul endroit où le vocabulaire est vraiment commun

Et il l'est parce que c'est **le script partagé qui l'écrit**. Les sept phases du type
`SetupStatus` de `@spunto/build/types` correspondent exactement à ce que
`@spunto/build/script` émet — vérifié en listant les appels : `credentials`, `dotfiles`, `cloning`,
`lifecycle`, `ready`, plus `initializing` (écrit quand il n'y a pas de credentials) et `error`
(écrit par le trap d'échec). Un script, un type, deux lecteurs. C'est le modèle à reproduire pour
les états de worker.

Deux scories quand même, une de chaque côté :

- **`features` n'est plus écrit par personne.** Notre type l'admet encore (`lib/types.ts:24`,
  `db/schema.ts:28`), et la doc de Cloud le décrit comme une phase courante avec sa propre séquence
  — alors que les features s'installent maintenant au build de l'image, pas au setup. Vocabulaire
  mort des deux côtés, vivant dans deux endroits.
- **`pending` est un sentinelle à nous, écrit par le plan de contrôle, jamais par un worker.** On
  l'insère au spawn (`services/workers.ts:264`) et au rebuild (`:398`) ; Cloud écrit
  `setupStatus: null` aux mêmes endroits. Or le design system traite les deux **identiquement** —
  `setupProgress(null)` et `setupProgress({phase:"pending"})` rendent tous les deux `5`, et
  `phaseLabel` rend « Starting up… » / « Setting up… ». Donc élargir le type partagé pour y loger
  cette valeur ne nous achète rien : elle dit exactement ce que `null` disait déjà, dans un champ
  que le paquet définit comme « ce que le worker rapporte ».

Autrement dit, notre élargissement du contrat ne couvre en réalité qu'une valeur morte et un
doublon de `null`. C'est le genre de chose qu'on garde par prudence et qui finit par coûter une
divergence de type entre deux produits.

## 6. `building` : le seul état où c'est Lite qui a le bon modèle

Cloud attend le build d'image aussi — c'est explicite dans `spawnAsync`
(`modules/workers/workers.service.ts:405`) : *« the first worker on a node will wait for the build
before spawning »*, avec un `waitForBuild` si un build est déjà en cours. Mais **son worker reste
`provisioning` pendant ce temps-là, sans le dire.**

Résultat : sa page worker reconstruit l'information côté client, par une jointure à la main sur les
builds du projet —

```ts
// apps/next/.../workers/[workerId]/page.tsx:152
const activeBuild = imageBuilds.find(b => b.nodeId === worker?.nodeId
                                       && b.version === currentVersion
                                       && b.state === "building")
                 ?? imageBuilds.find(b => b.nodeId === worker?.nodeId && b.version === currentVersion)
```

… là où nous lisons `worker.state === "building"`
(`app/(app)/projects/[id]/workers/[wid]/page.tsx:76`), ce qui nous sert aussi à décider de poller
toutes les 2 s et d'afficher le log de build.

Et sur la **carte**, les deux produits affichent la même chose d'inutile pendant toute la
construction d'une image : `settingUp` à vrai, `setupStatus` vide, donc « Setting up… 5 % » pendant
dix minutes. Chez nous parce que `toDsState` écrase `building` en `provisioning`
(`components/worker-card.tsx:52`), chez eux parce que l'état ne l'a jamais dit.

**Conclusion : `building` n'est pas une bizarrerie de Lite à normaliser, c'est un état que Cloud a
aussi et qu'il paie de ne pas nommer.** La bonne direction est de l'ajouter au vocabulaire partagé,
pas de le retirer d'ici.

## 7. Le prédicat « en cours d'installation » existe en trois copies

Le design system a `resolveWorkerStatus(...).settingUp`, qui est *la* réponse à cette question, et
qui gère les deux vocabulaires. Pourtant :

- `packages/design-system/.../worker-status.tsx:96` — `SETUP_STATES = {provisioning, starting,
  setup}`, `pulling` étant traité par un `if` séparé juste avant.
- `spunto-lite` — `isSettingUp(state)` (`components/worker-card.tsx`), qui passe bien par le design
  system, mais après avoir traduit deux valeurs.
- `apps/next` côté Cloud — réécrit en dur, **deux fois** : `state === "provisioning" || state ===
  "pulling" || state === "starting"` (`components/worker-actions.tsx:42` et la page worker,
  `:147`). Un `building` ajouté au paquet devrait être ajouté à la main dans ces deux endroits.

Trois copies d'un prédicat, c'est exactement la situation que l'en-tête de `worker-status.tsx`
raconte avoir voulu supprimer (« it used to live twice […] and the two had already drifted »).

Accessoirement, `docs/worker-states.md` côté Cloud annonce « `state` — état DB (6 valeurs) » et
n'en liste que six : `pulling` et `deleting` manquent, alors que l'enum en base en a huit.

## 8. Ce que je propose, et ce que ça coûte

Le point important d'abord : **aucun des deux enums n'est contraint en base.** Chez nous c'est
`text("state")` sans enum (`db/schema.ts`), chez Cloud c'est `text("state", { enum: [...] })`, qui en
Drizzle est une contrainte de type TypeScript et non un `CHECK` Postgres. Aucune migration de schéma
n'est nécessaire pour ajouter une valeur — c'est un changement de code, des deux côtés.

Par ordre de rendement :

1. **Ajouter `building` au vocabulaire partagé** (le paquet, puis le design system : une pastille
   « Building image… », et `building` dans `SETUP_STATES`). Ça sert les deux produits — Cloud gagne
   de pouvoir supprimer sa jointure côté client, nous gagnons la bonne étiquette et la suppression
   de `toDsState`. C'est le seul changement de la liste qui rend un état à quelqu'un au lieu de
   ranger du vocabulaire.
2. **Sortir le vocabulaire et le prédicat dans `@spunto/build`.** Le type union, plus
   `isSettingUp` / `isTerminal`, à côté de `SetupStatus` qui est déjà là. Le design system garde ses
   *couleurs* et ses *libellés* (c'est son métier) mais lit le vocabulaire du paquet ; les trois
   copies du prédicat tombent à une. Règle du paquet respectée : c'est du type et des fonctions
   pures, pas d'ORM, pas d'I/O.
3. **Renommer `pending` en `provisioning` chez nous** — même sens exactement, et une valeur
   transitoire : un worker en `pending` a bougé ou est mort, donc un `UPDATE workers SET
   state='provisioning' WHERE state='pending'` suffit, sans perte. À faire *après* le point 1, pour
   ne pas perdre `building` en route.
4. **Nettoyer `setupStatus` :** retirer `features` (mort partout) et `pending` (doublon de `null`) de
   notre élargissement, et écrire `null` au spawn comme Cloud. Notre type redevient celui du paquet,
   sans `Omit<>`. À garder pour la fin, parce que c'est le seul point de la liste qui touche des
   données déjà écrites en base — les vieux workers qui portent `phase: "features"` doivent être
   lus sans planter (le design system les résout déjà sur son `default`).
5. **Distinguer « mort » de « arrêté » chez nous**, en utilisant pour les workers ce que
   `inspectServiceContainer` fait déjà pour les services. Ça ne demande pas le second axe de Cloud
   (pas de node, pas de RPC qui échoue seul) : un `exited` distinct de `stopped`, plus l'`ExitCode`
   que Docker donne déjà, suffirait — et `exited` est **déjà** dans la table du design system.
   Indépendant du reste, et c'est le seul point qui corrige un vrai manque plutôt qu'une
   divergence.

Ce qu'il ne faut pas aligner : `dockerState` et `nodeId` (un plan de contrôle mono-machine n'a ni
node ni RPC qui échoue séparément), `stopping` et `deleting` (nos appels sont synchrones — un état
pour un instant qui n'existe pas serait un mensonge), et le modèle push/réconciliation.
