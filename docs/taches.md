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
   … la session rend la main (`session.ended` dans le flux, ou fin du process) → in-review
   Accept → `taskValidateCommand` (optionnelle) ; exit 0 → done
   Drop   → tue la session, `taskCancelCommand`, → failed ("Cancelled")
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
personne ne regarde — c'est lui qui gare un worker en mode `stop` et libère le pool.

**Le worker appartient à la tâche** jusqu'à `done`/`failed` : le libérer à l'entrée en revue
laisserait la tâche suivante faire `checkout -B` par-dessus ce qu'on relit. Un worker qu'un
humain utilise n'est jamais réquisitionné : seuls les workers tagués `task` forment le pool.

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
| Redémarrage pendant un job | le job reprend | dit sur la tâche au boot (`recoverInterruptedTasks`) : une tâche encore `queued` passe `failed` avec la raison, un Drop en vol est terminé, un Accept ou une réponse en vol est effacé avec une note |
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
| `taskReviewMode` | `keep` | `stop` : le conteneur est arrêté en revue, réveillé par Accept/Drop/une réponse |
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
| `components/task-panel.tsx`, `components/new-task-button.tsx`, `components/task-settings-card.tsx` | la section du projet, la délégation, les réglages |
| `lib/task-cache.ts`, `hooks/use-task-actions.ts` | les trois caches d'une tâche gardés d'accord, et les actions |
| `e2e/tests/tasks.spec.ts` | l'API sans Docker (validation, refus, formes) — tourne en CI |
| `e2e/tests/tasks-lifecycle.spec.ts` | bout en bout sur vrai conteneur, sans forge ni clé d'API (`E2E_DOCKER=1`) |
| `e2e/fixtures/fake-claude.js` | un faux Claude Code qui parle le vrai `stream-json` interactif |
