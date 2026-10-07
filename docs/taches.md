# Agents — le travail délégué

Une **tâche** est une unité de travail confiée à un agent : « corrige le login qui casse sous
Safari ». Elle a un worker, une branche, une session d'agent, et elle produit quelque chose à
relire. C'est la fonctionnalité *Agents* de Spunto Cloud, portée dans Lite : même modèle, mêmes
états, mêmes écrans (ils viennent de `@spunto/design-system/tasks`), même lecture de session (elle
vient de `@spunto/build/agent-stream`). La référence détaillée du modèle reste le `docs/tasks.md`
du dépôt Cloud ; cette page dit **ce qui est pareil, ce qui diffère dans Lite, et pourquoi**.

## Où la trouver

- **Agents** (barre latérale, `/agents`) — toutes les conversations, tous projets confondus, à
  gauche ; celle qu'on a choisie à droite. Groupées par état dans l'ordre où une tâche voyage
  (`queued` → `running` → `in-review`, puis `failed` et `done`), la plus récemment active en haut
  de chaque groupe. La sélection vit dans l'URL (`?task=`). Le bouton **New** délègue en
  demandant dans quel projet.
- **Page projet** → section *Tasks* au-dessus des workspaces, bouton **New task** dans l'en-tête,
  Accept / Drop sur la ligne.
- **Une conversation à son URL** : `/projects/:id/tasks/:taskId` — onglets *Session*, *Diff* et
  *Terminal*, la boîte de réponse sous les deux premiers, la colonne de faits à droite (branche, usage de la session, machine,
  prompt, ce qui a tourné).
- **Terminal** : un shell dans la machine de la tâche, sur sa branche. Ce sont les mêmes sessions
  dtach persistantes que la page worker (onglets, reprise après fermeture) — un shell ouvert ici s'y
  retrouve, et la session de l'agent n'en fait jamais partie. L'onglet n'existe que si la tâche a une
  machine ; machine arrêtée (garée pour la revue), il dit pourquoi il n'y a rien où taper.
- **Réglages** : page d'édition du projet → carte *Delegated work*.

## Démarrer avec Claude Code

Sans rien régler, une tâche lance Claude Code en mode interactif
(`claude --dangerously-skip-permissions -p` + `--output-format stream-json --verbose
--input-format stream-json`). Il faut donc, dans le projet :

1. la feature **`claude-code`** (catalogue) — sans elle, la session échoue sur
   `claude: command not found`, et la tâche le dit ;
2. un secret **`ANTHROPIC_API_KEY`** ou **`CLAUDE_CODE_OAUTH_TOKEN`** (projet ou global) ;
3. un **dépôt git** : une tâche travaille sur une branche. Le clone utilise la clé SSH des
   réglages, qui sert aussi au `git push` de l'agent.

## Cycle de vie

```
POST /api/projects/:id/tasks
   ├─ insert (state=queued, branch=task/<slug>-<id6>)
   └─ en tâche de fond :
        1. un worker : libre dans le pool du projet (redémarré s'il était arrêté), sinon spawné et tagué `task`
        2. attend `ready`
        3. dans chaque dépôt : [machine recyclée : reset --hard + clean -fd] fetch + checkout -B <branche> origin/<base>
        4. machine recyclée : `taskResetCommand` du projet
        5. la session d'agent, en commande background dans le worker → running
   … la session rend la main (`session.ended` sans travail de fond derrière, ou fin du process) → in-review
   Accept → `taskValidateCommand` (optionnelle) ; exit 0 → done
   Drop   → tue la session, `taskCancelCommand`, → failed ("Cancelled")
   done / failed → le worker rendu au pool est **garé** (arrêté, disque gardé), rebuildé d'abord s'il est en retard de config
```

| État | Veut dire |
|---|---|
| `queued` | la tâche attend sa machine (allocation, build d'image, démarrage, branche) |
| `running` | la session d'agent tourne |
| `in-review` | elle a rendu la main proprement : il y a quelque chose à juger |
| `done` | accepté — **seulement** par un clic |
| `failed` | session morte mal, machine impossible à obtenir, ou tâche abandonnée (`error` dit laquelle) |

L'état est **dérivé à la lecture** depuis la session, jamais sondé en boucle ; un plancher de
fond (toutes les 10 s, les tâches `running` non lues depuis 30 s) garde les choses vraies quand
personne ne regarde — c'est lui qui gare un worker en mode `stop`, voit une machine tombée sous
une session, et rend au pool celle d'une session morte.

**Le worker appartient à la tâche** jusqu'à `done`/`failed` : le libérer à l'entrée en revue
laisserait la tâche suivante faire `checkout -B` par-dessus ce qu'on relit. Un worker qu'un
humain utilise n'est jamais réquisitionné : seuls les workers tagués `task` forment le pool.

**Une fin de tour n'est pas une main rendue** (Cloud #385) : un tour de Claude Code peut finir
avec une tâche de fond vivante (`run_in_background`, un subagent), et le harnais se relance tout
seul quand elle finit. `session.background` (`@spunto/build` ≥ 0.9) dit ce qui tourne encore ; la
tâche ne passe en revue que si le dernier `session.ended` n'avait rien derrière lui
(`hasHandedBack`).

**Quand le process sort** (Cloud #423) : une session interactive ne sort pas entre deux tours.
Si son process meurt quand même (le timeout de 6 h, un crash, la machine qui redémarre) alors
que son dernier tour était fini, la tâche passe ou reste `in-review` — une réponse la reprend par
`--resume`. Elle n'est `failed` que si le process meurt en plein tour *et* qu'on ne peut pas
reprendre la conversation, ou pour une session one-shot.

## Rendre la machine au pool

Une tâche finie (Accept, Drop, échec) rend son worker au pool **garé** (Cloud #413, #398) : il
était laissé allumé jusqu'à la tâche suivante — parfois jamais. Avant de l'arrêter, s'il a été
construit sur une version plus ancienne du projet, il est rebuildé (le volume `/workspace` est
gardé, `postCreateCommand` est rejoué comme avec le bouton Rebuild) pour que la tâche suivante le
trouve à jour. La tâche suivante le redémarre en quelques secondes ; à l'allocation, le pool
préfère une machine à jour, puis allumée, et rebuilde celle qu'il prend si elle est en retard.

Rendre et reprendre une machine passent par le même verrou par worker (`withPoolLock`) — dans
Cloud un verrou advisory Postgres, dans Lite une chaîne de promesses, puisqu'il n'y a qu'un
process : sinon une tâche déléguée juste après un Accept prend la machine encore allumée, et le
rendu de la précédente l'arrête sous ses pieds.

## La machine d'une tâche

`machine` est un second axe de la tâche, dérivé du worker à chaque lecture, jamais écrit (Cloud
#391) — une tâche garée a toujours quelque chose à juger, elle reste `in-review` :

| `machine` | worker |
|---|---|
| `starting` | provisioning / building / starting |
| `awake` | ready |
| `parked` | stopped, ou tombé tout seul (crash, ordinateur redémarré) : disque intact, rallumé par une réponse, Accept, Drop ou Wake |
| `lost` | supprimé, ou son setup a échoué |
| `null` | pas encore de worker, ou tâche terminée |

Sous la section Machine du cockpit : **Park the machine** / **Wake the machine** (tâche en revue
seulement ; Park est refusé pendant un Accept, un Drop ou une réponse en vol, qui vont chacun la
rallumer). Le mode de relecture `stop`, c'est le Park automatique.

**Un seul chemin de réveil** pour une réponse, Accept, Drop et Wake : un worker arrêté — ou tombé
tout seul — est redémarré, un conteneur disparu est rebuildé sur le même volume ; seul un worker
dont le *setup* a échoué est refusé (le relancer échouerait pareil). Avant de reprendre la
session, une réponse lance dans chaque dépôt un **Branch check** (`followUpCheckoutScript`) : un
arbre propre sur une autre branche est remis sur celle de la tâche, un arbre modifié n'est pas
touché et la réponse est refusée avec la raison. Le script n'a aucun `exit` (Cloud #424 : dans le
shell de login des commandes, `exit` passe par `~/.bash_logout`, qui échoue sans console).

## Un ordinateur qui redémarre

Lite tourne sur des portables et des postes qu'on redémarre souvent ; ce n'est pas une panne :

- **Un worker arrêté par l'extinction est `stopped`, pas `error`.** En s'arrêtant, Docker stoppe
  les conteneurs comme `docker stop` (SIGTERM puis SIGKILL : exit 143 ou 137) ; après une coupure
  de courant, il retrouve les conteneurs morts et leur donne l'exit 255. Un conteneur sorti avant
  le dernier démarrage de la machine, ou par l'un de ces signaux, est tombé avec elle
  (`wentDownWithTheHost`, `lib/docker.ts`) ; un kill OOM ou un autre code reste un crash. Pareil
  pour les services partagés. Un worker déjà passé en `error` pour cette raison par une version
  précédente est corrigé à la lecture suivante.
- **Une tâche dont la machine s'arrête en plein tour passe `in-review`**, avec une note : une
  réponse réveille la machine et reprend la session. Dans Cloud la même situation est un échec
  (le nœud est un serveur, un arrêt y est anormal) ; Lite ne conclut `failed` que si la machine
  est supprimée, si son setup a échoué, ou si la conversation ne peut pas être reprise.
- **Une tâche encore `queued` reprend son lancement** au redémarrage de Lite, sur la machine
  qu'elle avait déjà (réveillée), au lieu de passer `failed`. Si sa session était déjà lancée,
  elle est adoptée plutôt que relancée.

## Ce qui est pareil que dans Cloud

- les **états**, la **dérivation**, l'**ordre des listes** (`lastActivityAt`), le **pool** ;
- le **script de branche** (`branchSetupScript`) et ses trois détails payés cher : `reset --hard`
  avant `checkout -B` sur une machine recyclée, `clean -fd` et jamais `-x`, ce qui est jeté est
  affiché avant ;
- la **session comme commande background dans le worker**, avec la même arborescence
  (`~/.spunto/commands/<id>/{cmd.sh,run.sh,stdin,stdout.log,exit_code}`) et le même
  `exec 9<>stdin` qui garde une session interactive vivante entre deux tours — portée depuis
  l'agent de nœud Cloud dans `lib/worker-commands.ts` ;
- l'**ingestion par curseur** : un offset en octets par commande, avancé par compare-and-swap,
  `seq` dense par tâche, les lignes du harnais gardées en `source` ;
- **répondre** (dans le stdin vivant si la session écoute, sinon reprise `--resume` sur l'id lu
  dans le flux), **interrompre** (`control_request/interrupt`), le **nom** que la session se
  donne (lu une fois dans son transcript), l'**usage** (contexte, tokens, coût venu du harnais),
  les **pièces jointes** dans les deux sens (déposées dans le worker, affichées si ce sont des
  images raster, téléchargées sinon), le **diff** lu avec git dans la machine ;
- les **réglages** : mêmes noms de champs que Cloud et que la spec portable, donc un projet
  exporté emporte son harnais.

## Ce qui diffère, et pourquoi

| | Cloud | Lite |
|---|---|---|
| Routes | `/api/orgs/{orgId}/projects/{projectId}/tasks/{taskId}/…` | `/api/tasks/{taskId}/…` à plat, comme `/api/workers/{id}` ; création et liste d'un projet sous `/api/projects/{id}/tasks` |
| Jobs | table `platform_jobs` durable | en mémoire, dans le process, comme le spawn d'un worker |
| `pendingAction` | dérivé des jobs vivants | écrit sur la ligne, effacé en `finally` |
| Redémarrage pendant un job | le job reprend | au boot (`recoverInterruptedTasks`) : le lancement d'une tâche encore `queued` reprend, un Drop en vol est terminé, un Accept ou une réponse en vol est effacé avec une note |
| Machine arrêtée sous une session | `failed` | `in-review` si la conversation peut être reprise (voir « Un ordinateur qui redémarre ») |
| Verrou du pool | advisory Postgres | chaîne de promesses par worker (un seul process) |
| Pool | par membre | par projet (un seul utilisateur) |
| Consigne d'agent | celle de l'org + celle du projet | la phrase par défaut + celle du projet |
| Diff indisponible | `no-machine`, `machine-stopped`, `node-unreachable`, `unsupported` | les deux premiers seulement : un seul démon Docker |
| Pull request | lue sur la forge connectée | absente — Lite ne parle à aucune forge |

**La session, elle, survit à un redémarrage de Lite** : c'est un process dans le worker, pas
dans le plan de contrôle. Le redémarrage ne perd que ce qui vivait en mémoire — une allocation en
cours, un Accept en cours.

**Les réglages de tâche ne créent pas de version.** Rien n'entre dans l'image : changer de
harnais ne doit pas marquer tous les workers comme périmés. La carte *Delegated work* fait un
`PATCH` qui ne contient qu'eux, et `updateProject` les applique sans version.

## Deux pièges trouvés au portage

Le premier existe aussi côté Cloud (même code), masqué par le poll du flux du cockpit ; le second
reste à vérifier là-bas, selon ce que sa lecture de commande répond pour un worker arrêté :

- **Le throttle d'ingestion en direct lisait `lastRefreshedAt`**, que *chaque* lecture réécrit.
  Un client qui ne sonde que la tâche plus vite que le throttle (la liste d'un projet, toutes les
  5 s) empêchait pour toujours l'ingestion — et une session interactive, dont la fin ne se voit
  que dans son flux, restait `running`. Lite garde une horloge à part (`lastLiveIngest`).
- **Une session sur un worker garé passait pour vivante** : le mode `stop` arrête le conteneur,
  mais la commande garde son dernier état connu (`running`), et une réponse partait écrire dans
  le stdin d'un conteneur arrêté. Une session n'est vivante que si sa machine est `ready`.

## Réglages du projet

| Réglage | Défaut | Renseigné |
|---|---|---|
| `taskAgentCommand` | `claude --dangerously-skip-permissions -p` | ta commande — le prompt arrive sur **stdin** |
| `taskAgentProtocol` | `claude-stream` (lu en direct, interactif) | `claude-json`, `jsonl` (notre vocabulaire), `none` |
| `taskFollowUpCommand` | `claude … --resume "$SPUNTO_TASK_SESSION_ID"` | ta reprise — la réponse arrive sur stdin |
| `taskResetCommand` | rien | ce qu'une machine recyclée doit reposer, après le checkout |
| `taskValidateCommand` | Accept clôt la tâche | lancée par Accept dans le worker ; exit 0 ⇒ `done` |
| `taskCancelCommand` | rien de plus que tuer la session | nettoyage lancé par Drop |
| `taskReviewMode` | `keep` | `stop` : le conteneur est garé en revue (Park automatique), réveillé par Accept/Drop/une réponse/Wake |
| `taskAgentModel` | le harnais choisit | modèle par défaut, ajouté en `--model` ; une tâche peut le surclasser |
| `taskAgentInstructions` | rien | ajouté à la consigne de chaque tâche du projet |

Variables fournies aux commandes : `SPUNTO_TASK_ID`, `SPUNTO_TASK_TITLE`, `SPUNTO_TASK_BRANCH`,
`SPUNTO_TASK_BASE_BRANCH`, `SPUNTO_TASK_STATE`, `SPUNTO_TASK_MODEL` (si résolu), plus les secrets
du projet **tels qu'ils sont maintenant** (l'environnement du conteneur date de son spawn).

## Routes

```
GET    /api/tasks                               — toutes les tâches (?state=&q=&projectId=&limit=&offset=), compteurs par état hors filtre d'état
GET    /api/projects/:id/tasks                  — celles d'un projet
POST   /api/projects/:id/tasks                  — délègue { prompt, title?, baseBranch?, model?, files? } → 201, queued
GET    /api/tasks/:taskId                       — détail, re-dérivé, + canResume
PATCH  /api/tasks/:taskId                       — renomme { title } (la branche ne bouge pas)
DELETE /api/tasks/:taskId                       — oublie une tâche finie (409 si vivante)
GET    /api/tasks/:taskId/commands              — ce que la plateforme a lancé, plus ancien d'abord
GET    /api/tasks/:taskId/events                — la session (?since= | ?tail=true | ?before=, &limit=, &source=true) + usage
GET    /api/tasks/:taskId/diff                  — ce que la branche change, par dépôt
GET    /api/tasks/:taskId/diff/patch            — le patch d'un fichier (?path=&repo=&oldPath=&untracked=)
POST   /api/tasks/:taskId/messages              — répond { prompt, files? } → 202
POST   /api/tasks/:taskId/interrupt             — arrête le tour en cours sans tuer la session → 202
POST   /api/tasks/:taskId/validate              — Accept → 202
POST   /api/tasks/:taskId/cancel                — Drop → 202
POST   /api/tasks/:taskId/park                  — gare la machine d'une tâche en revue (409 sinon, ou pendant une action en vol)
POST   /api/tasks/:taskId/wake                  — rallume la machine garée d'une tâche en revue
GET    /api/tasks/:taskId/attachments/:id       — les octets d'une pièce jointe (PNG/JPEG/WebP/GIF inline, le reste en téléchargement)
GET    /api/harness-packs                       — le catalogue des harnais (Claude Code)
```

## Où c'est implémenté

| Fichier | Rôle |
|---|---|
| `db/schema.ts` | tables `tasks`, `task_commands`, `task_events`, `task_attachments`, colonnes `projects.task_*` |
| `services/tasks.ts` | création, allocation, branche, session, dérivation, plancher de fond, Accept/Drop/réponse/interruption |
| `services/task-commands.ts` | ce qui a tourné pour une tâche, et sa réconciliation avec le worker |
| `services/task-events.ts` | ingestion par curseur, titre de session, usage |
| `services/task-diff.ts`, `lib/task-diff.ts` | le diff lu avec git dans le worker (scripts et parseurs repris de Cloud) |
| `services/task-attachments.ts`, `lib/task-attachments.ts` | pièces jointes dans les deux sens |
| `lib/worker-commands.ts` | commandes foreground/background dans un worker (port de l'agent de nœud Cloud) |
| `lib/harness-packs.ts` | le catalogue des harnais et `packMatches` |
| `app/(app)/agents/page.tsx` | le poste de pilotage |
| `components/task-cockpit.tsx` | une conversation — les données ; tout ce qui dessine vient du design system |
| `components/task-machine-controls.tsx` | Park / Wake sous la section Machine du cockpit |
| `components/task-panel.tsx`, `components/new-task-button.tsx`, `components/task-settings-card.tsx` | la section du projet, la délégation, les réglages |
| `lib/task-cache.ts`, `hooks/use-task-actions.ts` | les trois caches d'une tâche gardés d'accord, et les actions |
| `e2e/tests/tasks.spec.ts` | l'API sans Docker (validation, refus, formes) — tourne en CI |
| `e2e/tests/tasks-lifecycle.spec.ts` | bout en bout sur vrai conteneur, sans forge ni clé d'API (`E2E_DOCKER=1`) |
| `e2e/fixtures/fake-claude.js` | un faux Claude Code qui parle le vrai `stream-json` interactif |
