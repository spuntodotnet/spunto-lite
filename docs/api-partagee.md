# L'API partagée avec Spunto Cloud — état des lieux

> Point demandé le 2026-09-18 : « la création d'un projet, le listing des workers, les statuts,
> est-ce que c'est plus ou moins partagé ? ». Réponse courte : **les fondations le sont, l'API
> HTTP ne l'est pas du tout** — et ce n'est pas la même chose qu'un désaccord de conception.
>
> Comparé : `spunto-lite@2380336` et `coderhammer/spunto@32167ea`.

## Le verdict en une table

| Ce dont les deux produits parlent | Partagé ? | Où |
|---|---|---|
| Recette d'image, script de setup généré | **oui, le code** | `@spunto/build/script` |
| Noms Docker (conteneur, réseau, volumes, ref d'image) | **oui, le code** | `@spunto/build/naming` |
| Protocole de log de build (`::spunto:step:`) | **oui, le code** | `@spunto/build/steps` |
| Catalogues images / features / extensions | **oui, les données** — et `GET /api/images`, `GET /api/features` sont à la même adresse avec la même forme | `@spunto/build/catalogs` |
| Registre d'extensions (recherche, lookup, gallery) | **oui, le code** | `@spunto/build/extensions` |
| Contenu de `setupStatus` | **oui, le type** | `@spunto/build/types` |
| Fichier projet portable (`kind: "spunto/project"`) | **oui, le format** | `@spunto/build/spec` |
| Formulaire de composition d'un projet | **oui, le composant** | `@spunto/design-system/projects` |
| Pastilles et barre de progression d'un worker | **oui**, et sans adaptateur depuis le renommage | `@spunto/design-system/workers` |
| **Payload de création d'un projet** | non — deux schémas zod jumeaux, maintenus séparément | — |
| **Vocabulaire des états d'un worker** | *en partie* — 5 valeurs communes sur 9 depuis le renommage, et `building` est dans le paquet | — |
| **Forme de l'objet `Worker` sur le fil** | non, mais compatible par accident | — |
| **Routes, auth, scoping par organisation** | non, et c'est volontaire | — |
| **Client d'API** | non — Lite n'a aucun document OpenAPI | — |

La ligne de partage actuelle est nette et cohérente : **est partagé tout ce qui décrit un
environnement, rien de ce qui décrit une requête.** Les deux produits s'accordent sur ce qu'est un
projet ; ils ne s'accordent pas sur comment on en crée un.

## Création d'un projet

|  | Lite | Cloud |
|---|---|---|
| Route | `POST /api/projects` | `POST /api/orgs/{orgId}/projects` |
| Auth | aucune | session ou clé d'API + appartenance à l'org |
| Schéma | `lib/validation.ts` → `CreateProjectSchema` | `apps/api/src/modules/projects/projects.types.ts` → `CreateProjectSchema` |

Les deux schémas s'appellent pareil, vivent dans deux dépôts, et ont **douze champs identiques** :
`name`, `description`, `image`, `features[]`, `vscodeExtensions[]`, `prewarmImages[]`, `dind`,
`postCreateCommand`, `postStartCommand`, `repositories[]`, `forwardPorts[]`, `secrets[]`. Même
noms, mêmes types, mêmes bornes (`1..65535` sur un port des deux côtés). C'est de la duplication
pure : le formulaire qui les remplit est déjà le même composant.

Ce qui diverge légitimement : Lite ajoute `sharedVolumes`, Cloud ajoute les huit champs `task*`
(RFC 0020). La spec portable modélise déjà les deux en optionnel, avec la bonne règle — « un
produit ignore les champs pour lesquels il n'a pas de feature ».

Ce qui diverge **sans raison** :

- `features[].ociRef` : Lite l'accepte, le `CreateProjectSchema` de Cloud ne le modélise pas. Or la
  colonne Postgres le porte (`$type<ProjectFeature[]>` du paquet), la réponse `ProjectSchema` le
  renvoie, le formulaire le transporte, et la spec portable aussi. Zod retire les clés inconnues :
  **importer dans Cloud une spec Lite qui contient une feature OCI hors catalogue perd la ref en
  silence** — le projet se crée, la feature ne s'installe pas.
- `vscodeExtensions` : Lite valide la forme de l'id avec `isExtensionId`, qui vient du paquet
  partagé ; Cloud prend un `z.string()` nu. Le validateur commun n'est utilisé que par un des deux.
- `repositories[].branch` : Cloud valide avec `isValidGitRef`, Lite ne valide rien. Le script
  généré quote la ref de toute façon (c'est le paquet qui la quote), donc ce n'est pas un trou —
  mais l'erreur arrive dix minutes plus tard, dans un log de build, au lieu d'arriver au POST.
  `isValidGitRef` vit dans `apps/api/src/schemas.ts` : impartageable en l'état.
- Le geste « favori » : `{ favorite: boolean }` côté Lite, `{ favorited: boolean }` côté Cloud.

## Listing des workers

|  | Lite | Cloud |
|---|---|---|
| Route | `GET /api/projects/:id/workers` | `GET /api/orgs/:orgId/projects/:projectId/workers` |
| Spawn | `POST` même route, `{ name?, branch? }` | `POST` même route, `{ nodeId?, name?, branch? }` |

Dix champs sont communs et **portent le même nom et le même type** : `id`, `projectId`, `name`,
`state`, `setupStatus`, `branch`, `projectVersion`, `tags`, `containerId`, `createdAt` (ISO 8601
des deux côtés — Drizzle sérialise son `mode: "timestamp"` en `Date`, donc en ISO dans le JSON).

Cloud en a six de plus, tous adossés à une feature que Lite n'a pas : `userId` et `index`
(multi-utilisateur), `nodeId` (BYOC), `dockerState` (l'état runtime est derrière un RPC vers
l'agent, donc il peut échouer seul), `stoppedAt`, et `ports[]` — que Lite sert sur un endpoint
séparé (`GET /api/workers/:id/ports`).

Autrement dit : **un client écrit pour la liste de workers de Cloud lirait celle de Lite sans
broncher, à condition de traiter six champs comme optionnels.** C'est la divergence la moins chère
à refermer des trois.

## Les statuts

C'est là que c'est le plus intéressant, parce que **l'affichage est déjà unifié alors que le fil ne
l'est pas.**

`resolveWorkerStatus` (`@spunto/design-system/workers/worker-status.tsx`) est explicitement l'union
des deux vocabulaires : son en-tête raconte que la table vivait en double et avait déjà dérivé. Elle
prend un worker de n'importe quelle forme, tolère un état qu'elle ne connaît pas, et sait que
« les apps à un seul `state` (Spunto Lite) tombent dans le dernier bloc ».

Le vocabulaire brut est à **5 valeurs communes sur 9** — et compter les valeurs est la mauvaise
façon de lire la différence, parce que les deux produits ne font pas dire la même chose au mot
« état ». Analyse détaillée : [`etats-worker.md`](etats-worker.md).

| | `provisioning` | `building` | `pulling` | `starting` | `ready` | `stopping` | `stopped` | `deleting` | `error` |
|---|---|---|---|---|---|---|---|---|---|
| Lite | ✅ | ✅ | | ✅ | ✅ | | ✅ | | ✅ |
| Cloud | ✅ | *(le paquet le connaît, l'API ne l'émet pas)* | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

Ça n'a pas toujours été le cas : Lite appelait `provisioning` « `pending` », et le design system
résolvait son `building` et son `pending` sur son propre repli — d'où un adaptateur à l'entrée,
`toDsState`, qui faisait lire « Setting up… » à dix minutes de `docker build`. Les deux moitiés ont
été traitées : `building` est entré dans le paquet (design system 0.25.0), `pending` a été renommé
`provisioning` des deux côtés — workers **et** services, dont le vocabulaire est partagé exprès.
L'adaptateur n'existe plus, un état de Lite voyage désormais tel quel.

Restent quatre valeurs à Cloud seul, et elles ont toutes la même cause : son conteneur est au bout
d'un WebSocket, donc arrêter, supprimer et transférer une image ont une durée qu'il faut nommer.

Le reste des statuts, plus brièvement :

- **`setupStatus`** : le *contenu* est partagé (`SetupStatus` de `@spunto/build/types`, écrit par
  un script shell dans le conteneur et relu par le plan de contrôle — du protocole versionné, pas
  un type). Lite l'élargit de deux phases (`pending`, `features`) pour les workers d'avant. Mais
  Cloud en re-déclare un jumeau zod à la main dans `apps/api/src/schemas.ts` au lieu de dériver
  du paquet : deux définitions pour un contrat qui existe précisément pour n'en avoir qu'une.
- **État d'un projet** : Cloud en a un (`created | creating | ready | error | updating`), Lite n'en
  a pas — chez nous c'est le dernier build d'image qui porte l'information
  (`building | ready | error`, vocabulaire identique des deux côtés). Le design system exporte
  `ProjectStatePill`, que Lite n'utilise pas.
- **Services partagés** : les états de nos services (`pending | starting | ready | stopped |
  error`) reprennent volontairement ceux d'un worker. Le pendant Cloud, ce sont les services d'un
  déploiement, avec leur propre échelle (`stopped | pulling | starting | running | stopping |
  error`) — deux features différentes qui se ressemblent, pas une divergence à corriger.

## Le reste, en une ligne chacun

- **Export / import de projet** : entièrement partagé, format neutre, secrets en noms seulement.
  C'est le seul endroit où les deux produits s'échangent réellement un objet aujourd'hui.
- **Terminaux persistants** : `@spunto/build/terminal` est dans le paquet mais n'a qu'un
  consommateur — nous. Cloud a gardé son implémentation dans `apps/agent`.
- **MCP** : Cloud expose une vingtaine d'outils (`list_projects`, `list_workers`, `create_worker`,
  `run_command`…) en re-dispatchant dans son propre routeur HTTP en mémoire, ce qui lui évite de
  redupliquer ses contrôles d'accès. Lite n'a pas de serveur MCP du tout (`mcp/` chez nous, c'est
  le pont navigateur pour les tests d'UI).
- **Client** : Cloud génère son client depuis `openapi.yaml` (11 670 lignes, 120 chemins). Lite a un
  `apiFetch<T>` écrit à la main et **aucun document d'API**. Conséquence directe : `spunto-mobile`
  ne peut structurellement parler qu'à Cloud.

## Ce qu'il faudrait pour partager plus, par rendement décroissant

1. **Le cœur du payload de création dans `@spunto/build`.** Les douze champs communs en un schéma
   zod, plus les validateurs de forme (`isExtensionId` y est déjà, `isValidGitRef` est à y
   déplacer) ; chaque produit étend avec ses champs propres, comme la spec portable le fait déjà et
   comme `ProjectFormValue` le fait côté UI. Ça passe la règle du paquet (pas d'ORM, pas de Hono,
   pas d'I/O), `zod` y est déjà en peer optionnelle, et ça referme d'un coup les trois dérives de
   validation listées plus haut. Coût faible, c'est le meilleur achat.
2. **Un vocabulaire d'états worker partagé** — *fait pour la moitié qui se voit.* Le choix n'était
   pas technique : renommer `building` en `pulling` et perdre le mot juste, ou donner au paquet le
   mot qui manquait. C'est la seconde qui a été prise (design system 0.25.0), et `pending` est
   devenu `provisioning` dans le même mouvement : `toDsState` n'existe plus. Ce qui reste est le
   vocabulaire **lui-même**, encore déclaré deux fois — une union dans `lib/types.ts` ici, un enum
   Drizzle là-bas — plus le prédicat « en cours d'installation », qui vit toujours en trois copies.
   Le sortir dans `@spunto/build`, à côté de `SetupStatus` qui y est déjà, est le pas suivant.
   Et côté Cloud, `apps/api` n'émet toujours pas `building` : sa page worker refait la jointure.
3. **Un OpenAPI pour Lite.** Sans document, pas de client généré, pas de test de contrat, et aucun
   client tiers ne pourra jamais viser les deux. C'est le préalable à tout le reste, et le plus
   gros morceau.
4. **Les alignements gratuits** : `favorite` → `favorited`, et `ports[]` dans le worker de la liste.
5. **Ce qu'il ne faut surtout pas partager** : le scoping `/orgs/{orgId}/`, l'auth, `nodeId` /
   `dockerState` (un plan de contrôle mono-machine n'a pas de node ni de RPC qui échoue seul), les
   tasks, et le couple déploiements/services. Les modèles d'exécution diffèrent par conception —
   c'est déjà la conclusion de `docs/shared-packages.md` côté Cloud sur le client Docker.

## Dérives repérées en chemin (côté Cloud)

À remonter là-bas, pas à corriger ici :

- **`UpdateProjectSchema = CreateProjectSchema.partial()` écrase des champs.** En zod 4,
  `.partial()` conserve les `.default()` — vérifié : `Create.partial().parse({})` rend
  `{ vscodeExtensions: [] }`. Et `updateProject` fait `.set({ ...input })`. Donc un `PATCH` qui ne
  mentionne pas `features`, `vscodeExtensions`, `prewarmImages`, `repositories`, `forwardPorts` ou
  `dind` les remet à vide. La ligne `input.repositories ?? existing.repositories` juste au-dessus
  prouve que l'intention était l'inverse. C'est exactement le piège que notre
  `UpdateProjectSchema` documente avoir évité en s'écrivant à la main — l'UI d'édition renvoyant
  le formulaire complet, ça ne se voit pas depuis le dashboard, seulement depuis l'API, le MCP ou
  le mobile.
- **`features[].ociRef` perdu à la création** (détaillé plus haut). Le champ traverse le
  navigateur et meurt à la frontière de l'API.
- **`docs/worker-states.md` annonce 6 états**, le schéma en a 8 : `pulling` et `deleting` manquent
  au tableau.
