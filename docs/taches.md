# Agents — le travail délégué

Une **tâche** est une unité de travail confiée à un agent : « corrige le login qui casse sous
Safari ». Elle a un worker et une session d'agent, et elle produit quelque chose à relire. Pas de
branche à elle : Lite n'en crée plus, l'agent en fait une s'il en a besoin, et la nomme (voir
« [Sans git : l'agent décide](#sans-git--lagent-décide) »). C'est la fonctionnalité *Agents* de Spunto Cloud, portée dans Lite : même modèle, mêmes
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
  *Terminal*, la boîte de réponse sous les deux premiers, la colonne de détails à droite
  (§ [La colonne de détails](#la-colonne-de-détails)).
- **Terminal** : un shell dans la machine de la tâche, sur le checkout tel que l'agent l'a laissé. Ce sont les mêmes sessions
  dtach persistantes que la page worker (onglets, reprise après fermeture) — un shell ouvert ici s'y
  retrouve, et la session de l'agent n'en fait jamais partie. L'onglet n'existe que si la tâche a une
  machine ; machine arrêtée (garée pour la revue), il dit pourquoi il n'y a rien où taper.
- **Réglages** : page d'édition du projet → carte *Delegated work*.

## Démarrer : les apps d'agent (Claude Code, Codex, Mistral Vibe)

Comme dans Cloud depuis la RFC 0048 (`docs/agent-apps.md` du dépôt Cloud), le projet ne décrit
plus *comment* lancer son agent : il **dit quelles apps ses tâches peuvent utiliser**, et **chaque
tâche choisit la sienne**.

| App | SDK officiel | Secret lu par le SDK |
|---|---|---|
| `claude` — **Claude Code** | `@anthropic-ai/claude-agent-sdk` | `ANTHROPIC_API_KEY` |
| `codex` — **Codex** | `@openai/codex-sdk` | `OPENAI_API_KEY` ou `CODEX_API_KEY` |
| `mistral` — **Mistral Vibe** | aucun : `vibe-acp` (Python), piloté en ACP par le runner | `MISTRAL_API_KEY` |

Il faut donc, dans le projet :

1. au moins une app allumée dans **Edit → Delegated work → Harness** (`agentAppIds`, liste
   ordonnée : la première est le défaut, *Make default* en promeut une autre). Un nouveau projet
   arrive avec Claude Code ; un projet sans app ne peut pas déléguer (`400`) ;
2. le **secret** de l'app (projet ou global) — le runner n'en lit aucun lui-même, le binaire
   lancé par le SDK hérite de l'environnement de la session ;
3. c'est tout : **un dépôt n'est pas requis**. Sans dépôt, la session tourne dans `/workspace` ;
   avec, dans le premier dépôt, cloné avec la clé SSH des réglages — celle qui sert aussi au
   `git push` de la branche que l'agent choisit de pousser.

**L'image.** Chaque app allumée ajoute sa feature (`spunto-agent-claude`, `spunto-agent-codex`,
`spunto-agent-mistral`, des `localScript` livrés par `@spunto/build`, cachés du sélecteur) **après**
celles du projet (`effectiveFeatures`, `lib/agent-apps.ts`) : un Node privé et le SDK épinglé sous
`/opt/spunto/agents`, plus le CLI sur le `PATH` pour les humains du terminal. Mistral Vibe n'a pas
de SDK Node : sa feature installe uv, un Python à lui et `mistral-vibe` épinglé sous
`/opt/spunto/agents/mistral` (le Python de l'image, absent ou trop vieux, ne compte jamais), et
met `vibe` / `vibe-acp` sur le `PATH`. Le build télécharge uv depuis astral.sh. La liste fait donc
partie de la version : la changer crée une version et rebuild, comme changer une feature.

**La session : le runner.** Une entrée `.mjs` du paquet (`claude.mjs`, `codex.mjs`,
`mistral.mjs`) qui importe l'adaptateur de son harnais (`claude/adapter.ts`…). Depuis
`@spunto/build` 0.23, Lite la **bundle** avec ce qu'elle importe (esbuild, `platform: node`,
`format: esm`, `target: node20`, une fois par process et gardé, comme `runnerBundle` de Cloud) en un
seul fichier, **pas** cuit dans l'image : il est passé en base64 dans l'environnement de la
commande, qui l'écrit puis s'exécute dessus — une correction du runner arrive avec une montée de
`@spunto/build`, sans rebuild. esbuild est donc une dépendance de prod de Lite, et reste hors du
bundle serveur de Next (`serverExternalPackages`) ; dans ce bundle, `runnerFile` pointe sur une copie
du seul `.mjs`, sans son adaptateur, et l'entrée est relue dans `node_modules/@spunto/build`.
`AGENT_RUNNERS_DIR` remplace toujours l'entrée d'un harnais par `<id>.mjs`, bundlée à chaque session
(c'est un outil de mise au point) :

```
<node> <runner>.mjs run [--model <id>] [--resume <session id>]
stdin   {"type":"user","text"} · {"type":"interrupt","id"} · {"type":"title","id","description"}
stdout  le contrat d'agent Spunto (agent-v1) : notre vocabulaire, une ligne par événement,
        avec en `source` le message du harnais dont il vient — lu par un seul lecteur strict
```

**Une session garde le dialecte sur lequel elle a commencé** (Cloud cf96aa07) :
`tasks.session_protocol` (migration `0013`) est écrit au lancement de chaque session (`agent-v1`
aujourd'hui) et dit comment la lire (`protocolOf`). Une session lancée par un Lite d'avant la montée
n'en a pas : elle reste lue dans l'ancien dialecte de son app (`claude-runner`, `codex-runner`, le
`legacyProtocol` du harnais) jusqu'à sa fin ; sa prochaine reprise démarre sur le contrat. Le
dialecte d'une session est écrit **avant** son lancement : un redémarrage de Lite entre le lancement
et la ligne qui l'enregistre adopte la session, et doit la lire dans le bon dialecte.

Comme dans Cloud, Lite ne mesure plus la fenêtre de contexte auprès de l'API Models d'Anthropic :
le runner Claude la donne lui-même dans `session.started`, et Lite ne lit plus aucune clé ni jeton
Anthropic.

Tous les dialectes de runner sont interactifs : une réponse pendant un tour part dans le stdin vivant (Codex
la garde pour la fin du tour), une interruption arrête le tour sans tuer la session. Le titre de la
conversation est **demandé** à la session juste après le premier tour (`sessionTitleRequestLine`) :
Claude Code ne se nomme plus tout seul en `stream-json`.

**Le modèle et les paramètres suivent le harnais.** Le projet a un modèle par défaut **par app**
(`taskAgentModels`, vérifié contre le catalogue de l'app) ; le composer de délégation propose le
harnais en premier, puis les modèles de cette app et **une chip par paramètre qu'elle déclare**
(Claude : `effort` ; Codex : `reasoningEffort` restreint par modèle, `webSearch`). La tâche fige
son choix (`tasks.agent_app_id`, `tasks.agent_options`, vérifiés contre le catalogue), conservé à
chaque reprise, et le runner le reçoit dans `SPUNTO_AGENT_OPTIONS`.

**Les serveurs MCP** allumés pour le projet arrivent dans la session par `SPUNTO_AGENT_MCP`,
servis par la passerelle de Lite → [serveurs-mcp.md](serveurs-mcp.md).

**Le texte s'affiche pendant qu'il s'écrit** (Cloud ebadc730, 0b31082b) : chaque session reçoit
`SPUNTO_AGENT_STREAM=1` (`STREAM_ENV`), et son runner imprime alors les morceaux d'un message en
cours (`message.delta` : Claude par `includePartialMessages`, Mistral par les chunks ACP de Vibe ;
Codex n'en donne que s'il envoie des `item.updated`). Ce ne sont pas des événements : l'ingestion
les plie (`foldDraft`) en un **brouillon** tenu en mémoire (sur `globalThis`, les deux graphes de
modules du process le partagent), jamais stocké, remplacé par le `message` fini dès qu'il arrive,
oublié après 5 minutes sans suite. `GET /api/tasks/:id/events` le rend dans `draft`, le fil le
dessine à la place de « working… » (`TaskEventStream`, prop `draft`) et sonde toutes les 700 ms
tant qu'il y en a un. Un redémarrage de Lite ne perd que quelques secondes d'aperçu.

**Les tâches d'avant les apps** (`agent_app_id` nul) finissent sur le CLI où elles ont commencé
(`LEGACY_CLI`, avec la commande et le dialecte de l'ancienne colonne du projet) : une session
vivante se parle dans son dialecte. Les colonnes `task_agent_command`, `task_agent_protocol`,
`task_follow_up_command` et `task_reset_command` ne sont plus ni écrites ni exposées ; elles
partiront quand plus aucune tâche ancienne ne vivra. La migration `0012` a passé chaque projet
existant sur Claude Code, avec une nouvelle version (son image gagne le SDK), et rangé son ancien
modèle par défaut dans `taskAgentModels` quand le catalogue le connaît.

## Cycle de vie

```
POST /api/projects/:id/tasks
   ├─ insert (state=queued, branch=null)
   └─ en tâche de fond :
        1. un worker : libre dans le pool du projet (redémarré s'il était arrêté), sinon spawné
           (cloné sur la base de la tâche) et tagué `task`
        2. attend `ready`
        3. machine recyclée seulement — « Workspace reset », dans chaque dépôt : reset --hard + clean -fd,
           fetch + checkout -B <base> origin/<base> (le checkout d'un clone neuf) ; machine neuve : rien
        4. la session d'agent (le runner de son app), en commande background dans le worker → running
        5. la demande de titre, juste derrière le premier tour
   … la session rend la main (`session.ended` sans travail de fond derrière, ou fin du process) → in-review
   Accept → `taskValidateCommand` (optionnelle) ; exit 0 → done
   Drop   → tue la session, `taskCancelCommand`, → failed ("Cancelled")
   done / failed → le worker rendu au pool est **garé** (arrêté, disque gardé), rebuildé d'abord s'il est en retard de config
```

| État | Veut dire |
|---|---|
| `queued` | la tâche attend sa machine (allocation, build d'image, démarrage, remise à plat d'une machine recyclée) |
| `running` | la session d'agent tourne |
| `in-review` | elle a rendu la main proprement : il y a quelque chose à juger |
| `done` | accepté — **seulement** par un clic |
| `failed` | session morte mal, machine impossible à obtenir, ou tâche abandonnée (`error` dit laquelle) ; une réponse peut la reprendre (voir « Reprendre une tâche en échec ») |

L'état est **dérivé à la lecture** depuis la session, jamais sondé en boucle ; un plancher de
fond (toutes les 10 s, les tâches `running` non lues depuis 30 s) garde les choses vraies quand
personne ne regarde — c'est lui qui gare un worker en mode `stop`, voit une machine tombée sous
une session, et rend au pool celle d'une session morte.

**Le worker appartient à la tâche** jusqu'à `done`/`failed` : le libérer à l'entrée en revue
laisserait la tâche suivante remettre à plat le checkout qu'on relit. Un worker qu'un
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

## Reprendre une tâche en échec

`failed` ne veut plus dire « fini pour de bon » (Cloud 22c7b0fd). Le worker d'une tâche en échec
est seulement garé, avec son disque, son checkout et le transcript du harnais : **une réponse
la reprend**. La tâche repasse `in-review` (`reopenTask`, l'erreur et `completedAt` effacés,
`session.reopened` dans la timeline), puis la réponse suit le chemin habituel : réveil de la
machine, `--resume` sur l'id de session.

Le cockpit affiche alors le compositeur normal. Sinon, un mot dit pourquoi on ne peut pas reprendre
(`reopenBlocker`, sur `GET /api/tasks/:id` avec `canReopen`) :

- le worker n'existe plus, ou son setup a échoué (le rebuilder depuis sa page, puis répondre) ;
- la session n'a jamais démarré, ou aucun id de session n'a été lu ;
- l'app d'agent de la tâche n'est plus autorisée par le projet.

**Une différence avec Cloud : la machine peut être partagée.** Dans Cloud, une sandbox appartient à
une seule tâche. Dans Lite, le worker rendu au pool a pu être donné à une autre tâche entre-temps.
On le laisse faire : les deux conversations partagent alors le worker, avec le même checkout. Pour
qu'une tâche n'éteigne pas la machine sous l'autre, aucun parquage (mode `stop`, « Garer plus
tard », Park à la main) n'arrête un worker où une autre tâche travaille (`queued`, `running`, ou
une action en vol), voir `workedOnByAnother`. Park à la main répond 409 dans ce cas.

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

**Les ports de la machine** (Cloud c429724d) : ceux que le projet déclare (`forwardPorts`), avec
le **label** et le **chemin** que le formulaire leur donne (`portsAttributes`, page *Runtime*),
plus tout ce qui écoute dans le worker. Vert et lien (chemin compris) quand quelque chose écoute,
grisé sans lien sinon — y compris machine garée, pour voir ce que l'app servira. Servis par
`GET /api/workers/:id/machine-ports`, qui ne demande rien au worker s'il n'est pas `ready`.

### Garer plus tard

Garer à la seconde où la session rend la main coûte cher quand on itère vite : chaque réponse
rallume la machine. `taskReviewParkAfterMinutes` (*Worker during review → Park it → Park after N
minutes*, `0` par défaut = tout de suite, au plus 1 440) laisse la machine **debout N minutes** en
revue (Cloud 275d6fed) :

- l'échéance est **écrite sur la tâche** (`tasks.park_at`) à l'entrée en revue. Cloud en fait un
  job `task.settle` au `run_at` futur ; Lite n'a pas de table de jobs et son process redémarre avec
  l'ordinateur, donc c'est la ligne qui la porte, et le plancher de fond (toutes les 10 s,
  `parkDueTasks`) gare ce qui est échu. Un redémarrage de Lite ne perd rien ; une échéance passée
  pendant qu'il était arrêté est honorée au premier tick ;
- la tâche l'expose en **`parkAt`** (null hors `in-review` ou machine pas `awake`), et le panneau
  Machine en fait un compte à rebours avec **Keep awake** (`POST /api/tasks/:id/keep-awake`, 409
  s'il n'y a rien de programmé), qui l'efface : la machine reste debout pour cette revue, Park la
  gare toujours à la main ;
- **répondre l'annule** aussi, et la revue suivante en programme une neuve ; Park à la main
  l'efface ;
- à l'échéance, rien ne se passe si la tâche n'est plus `in-review`. Pendant un Accept ou un Drop
  en vol, l'échéance est **gardée** pour un tick suivant (Cloud, lui, la consomme) : un Accept qui
  échoue laisse la tâche en revue, où le parquage a toujours lieu d'être.

Pas dans le spec d'export `@spunto/build` (0.25), comme les labels des ports : Lite les écrit à
côté, sous les noms de Cloud, et les relit lui-même (`ProjectExtras`, `lib/project-export.ts`).

**Un seul chemin de réveil** pour une réponse, Accept, Drop et Wake : un worker arrêté — ou tombé
tout seul — est redémarré, un conteneur disparu est rebuildé sur le même volume ; seul un worker
dont le *setup* a échoué est refusé (le relancer échouerait pareil). Le checkout **n'est pas
touché** : la conversation reprend là où l'agent a laissé le dépôt, sur la branche qu'il a prise
(ou aucune). Un *Branch check* remettait l'arbre sur la branche de la tâche et refusait la
réponse si l'arbre était sale ; Cloud l'a retiré (#557) : il n'a refusé que des agents qui
avaient changé de branche eux-mêmes, sur une machine qu'eux seuls tenaient.

## Sans git : l'agent décide

Comme dans Cloud depuis la RFC 0056 (BAC-61, Cloud `ab56551c`) : **Lite ne crée plus de
branche**, et ne demande plus de dépôt. Le *Branch setup* (`fetch` + `checkout -B task/<slug>-<id6>`
dans chaque dépôt avant la session) a disparu : il se battait avec les checkouts que l'agent ou
l'humain avaient mis ailleurs, et faisait échouer toute tâche d'un projet sans dépôt (« No git
repository at /workspace, so there is nothing to branch »). La session démarre sur le checkout tel
que le setup du worker l'a cloné ; l'agent crée une branche s'il en veut une, et la nomme.

- **La base reste** (chip *Base branch* du composer, `baseBranch`), pour ce qu'elle est : la branche
  que le worker clone (`spawnWorker(…, baseBranch)`), et celle sur laquelle une machine recyclée est
  remise. Vide : la branche configurée du dépôt, sinon celle par défaut du remote. Un projet sans
  dépôt n'a pas de chip, et une base envoyée par l'API y est ignorée (`baseBranch: null`).
- **Le préambule ne parle plus de branche** : `Spunto context: you are running in a disposable
  worker, in <cwd>[, starting from <base>].` La consigne par défaut est un fait, pas une
  procédure git : *« This worker goes to another task once this one is accepted or dropped, and its
  checkout is reset then: anything worth keeping has to leave it before then (for code: commit it
  on a branch you name, and push it). »*
- **Le diff reste**, en lecture : il compare l'arbre au merge-base de la base (celle de la tâche,
  sinon la branche configurée du dépôt, sinon celle du remote), quelle que soit la branche que
  l'agent a créée ; l'en-tête montre la branche **courante**, lue dans le worker. Un `/workspace`
  sans `.git` dit « No git repository in /workspace, so there is no diff to show » au lieu d'une
  erreur.
- **Accept / Drop** tournent dans le worker de la tâche : ils lisent la branche de l'agent dans le
  checkout — `git push origin "$(git branch --show-current)"`. `SPUNTO_TASK_BRANCH` n'est posé que
  pour une tâche qui en a une (les anciennes) ; `SPUNTO_TASK_BASE_BRANCH` reste.
- **Les tâches d'avant** gardent leur branche (`tasks.branch` devient nullable, migration `0013`,
  aucune valeur effacée) : elle est affichée dans la liste et les détails, passée en
  `SPUNTO_TASK_BRANCH`, et l'étape *Branch* de leur démarrage est encore dessinée (le design
  system ne la montre que si une commande `Branch setup` a tourné). Une réponse reprend leur
  session sans toucher au checkout, comme avant.
- **Le panneau « PR de la branche »** que Cloud a retiré (`7f1b709d`) n'a jamais existé dans Lite,
  qui ne parle à aucune forge : rien à retirer.

La migration `0013` est écrite à la main : SQLite ne sait pas retirer un `NOT NULL`, il faut
reconstruire la table, et la reconstruction que génère drizzle-kit (`PRAGMA foreign_keys=OFF`,
`DROP TABLE tasks`) effacerait en cascade l'historique de chaque tâche — le pragma ne fait rien
dans la transaction du migrateur. Les tables filles (`task_commands`, `task_events`,
`task_attachments`, `mcp_gateway_tokens`) sont donc copiées à part, puis remises.

### La machine recyclée : propre, comme un clone neuf

C'est la seule différence de fond avec Cloud, où chaque tâche a sa sandbox, jetée à l'Accept ou au
Drop. Le worker d'une tâche Lite retourne au pool, et la tâche suivante le reprend : sans branche
de setup, rien ne remettait plus son checkout à plat. Avant la session, dans chaque dépôt (ou
`/workspace`), Lite lance donc **« Workspace reset »** (`workspaceResetScript`) — seulement sur une
machine recyclée, jamais sur une neuve :

1. ce qui est jeté est **affiché d'abord** (`git status --porcelain`, et la branche où l'agent
   précédent avait laissé l'arbre) ;
2. `reset --hard` puis `clean -fd`, **jamais `-x`** : les fichiers ignorés (`node_modules`, caches)
   sont la raison d'être du recyclage ;
3. `fetch` + `checkout -B <base> origin/<base>` : le checkout d'un clone neuf, sur la base de la
   nouvelle tâche. Un commit jamais poussé sur cette branche locale est un reste comme un autre ;
   les branches que l'agent précédent a créées restent dans le dépôt, hors du checkout.

Pas de dépôt à cet endroit : l'étape le dit (« No git repository in /workspace — nothing to
reset ») et passe ; les fichiers de la tâche précédente restent dans `/workspace`. Un échec
(base inconnue du remote, remote injoignable) fait échouer la tâche avec un message qui dit quoi
faire, avant toute session.

## La colonne de détails

Tout ce qui est un *fait sur* la tâche plutôt qu'un moment de sa session, dans `TaskDetails` du
design system — l'ordre est le sien, Lite fournit les données (`components/task-cockpit.tsx`) :

1. **En tête** : « Delegated … · ran … », l'erreur s'il y en a une, puis les **liens** posés par
   celui qui a délégué (§ [Liens et métadonnées](#liens-et-métadonnées)), la **branche** (copiable)
   et la **base** — seulement si elle a été donnée : `baseBranch: null`, c'est la branche par
   défaut du dépôt, et le dire sur chaque tâche ne disait rien (Cloud 4d5dfe2b). Pas d'avatar de
   « qui a délégué » : Lite n'a qu'un utilisateur.
2. **Machine**, en premier et **toujours ouvert** : c'est sur lui qu'on agit (la page du worker,
   un port, Park / Wake). Ni lieu, ni CPU, ni « Open the editor » (dépréciés en 0.72) : le nom du
   worker mène à sa page, qui a l'IDE.
3. **Session** (nos chiffres : contexte, tokens, coût, tours), puis juste dessous **Claude Code** :
   ce que le harnais dit de sa session, lu dans ses propres lignes (`task_events.source`) — les
   jauges du quota du plan (fenêtres 5 h et semaine, remise à zéro, dépassement) depuis le
   `rate_limit_event`, les serveurs MCP et leur état, les skills et agents, le nombre d'outils, le
   mode de permission, la version, l'id de session (copiable) depuis `system/init`, et depuis la
   ligne `result` le coût par modèle quand il y en a plusieurs, la réflexion, les sous-agents, les
   permissions refusées, les recherches web. Un champ absent est une ligne absente. Codex n'écrit
   rien de tout ça : pas de bloc pour lui (`lib/claude-tile.ts`, porté de Cloud 8fa27672).
4. **Pull requests** : les PR (GitHub, GitLab `!n`, Bitbucket) reconnues parmi les liens partagés,
   une par PR. **Le lien seulement** : Lite ne parle à aucune forge (clone et push passent par la
   clé SSH), donc ni état, ni checks, ni revue comme les dessine l'app GitHub de Cloud.
5. **Shared links** / **Shared files** — § [Ce qui a circulé dans la conversation](#ce-qui-a-circulé-dans-la-conversation).
6. **Prompt**, **What ran**, **Metadata**.
7. **Monitoring**, le dernier : où tourne le worker (« This computer · Docker »), CPU et mémoire
   en direct tant que la tâche tient une machine allumée, et leur **historique** sur 1 h, 6 h,
   24 h ou 7 j (moyenne et pic de CPU, mémoire sous sa limite).

Chaque bloc sauf Machine part **replié** et reste comme on le laisse, dans toutes les
conversations (`localStorage` du navigateur, clé `spunto:task-details:open`, Cloud 05aee040).

**L'historique, sans backend de télémétrie.** Cloud relit les battements de ses sandboxes dans
OpenObserve ; Lite échantillonne lui-même `docker stats` toutes les 30 s pour chaque worker
`ready`, dans SQLite (`worker_samples`), et oublie ce qui a plus de 7 jours (une purge par heure)
— environ 2 900 lignes par jour et par worker allumé. Moyenné par tranche (1 min, 5 min, 15 min,
1 h) à la lecture. C'est l'historique **du worker** : une machine recyclée du pool montre aussi
ce qu'elle a fait pour les tâches d'avant (`services/worker-metrics.ts`).

**« In review » se dessine avec le point de la machine** (Cloud 924761e6) : partout où l'état
d'une tâche est dessiné (listes, en-tête du cockpit), l'icône d'une tâche en revue est le point du
worker — vert qui pulse allumé, gris arrêté (garé), jaune au démarrage, rouge perdu. Lite n'a pas
de pause mémoire : jamais de bleu. Le libellé « In review » ne change pas.

## Ce qui a circulé dans la conversation

`GET /api/tasks/:id/shared` rassemble chaque lien http(s) écrit dans un message — humain ou agent,
hors sortie d'outil et blocs de code clôturés —, dédupliqué sur l'URL, le plus récemment écrit
d'abord (un lien redit remonte), avec son texte s'il était un lien markdown, qui l'a écrit le
premier et combien de fois ; et chaque pièce jointe de la conversation, sans les octets. Dérivé
des événements à la lecture, jamais stocké (`lib/task-shared.ts`, porté de Cloud d7ae6d70).
`GET /api/tasks/:id/tiles` en tire les blocs *Claude Code* et *Pull requests*.

## Liens et métadonnées

Ce que **celui qui délègue** dit de la tâche — à la création (`POST`) ou après (`PATCH`) —, et
que Lite n'écrit jamais (Cloud 66528861). Le cas d'origine : une automatisation de backlog qui
crée une tâche quand une carte passe en `ready` ; la carte savait quelle tâche elle avait lancée,
la tâche ne savait pas d'où elle venait. Deux champs, deux lecteurs :

- **`links`** — `[{ label, url }]`, pour un **humain** : dessinés en tête des détails, la première
  chose qu'on cherche en arrivant d'une liste. `http(s)` seulement, 10 au plus. Un `PATCH` les
  remplace en bloc.
- **`metadata`** — paires `clé → texte`, pour une **machine** : 50 clés de 1–40 caractères
  `A–Z a–z 0–9 _ . -`, valeurs ≤ 500. Montrées repliées, jamais interprétées. Un `PATCH` les
  **fusionne** clé par clé : une chaîne pose, `null` ou `""` retire, une clé absente ne bouge pas.

**Retrouver une tâche** : `?metadata[clé]=valeur` (répétable, toutes les paires doivent y être)
sur `GET /api/tasks` et `GET /api/projects/:id/tasks` ; une clé impossible est un `400`. **La
session les reçoit** en `SPUNTO_TASK_METADATA` / `SPUNTO_TASK_LINKS` (JSON, posées seulement s'il
y en a) : un agent retrouve sa carte sans qu'on la recopie dans le prompt.

Cloud les expose aussi par son serveur MCP ; Lite n'en a pas (`mcp/` est le pont navigateur des
tests d'UI, [`api-partagee.md`](api-partagee.md)) : l'API HTTP est le seul chemin.

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
- **pas de git pour la tâche** (RFC 0056) : ni branche créée, ni dépôt requis, la base comme point
  de départ du clone, le préambule et la consigne par défaut sans branche, `SPUNTO_TASK_BRANCH`
  pour les seules anciennes tâches, le diff qui dit « pas de dépôt » ;
- la **session comme commande background dans le worker**, avec la même arborescence
  (`~/.spunto/commands/<id>/{cmd.sh,run.sh,stdin,stdout.log,exit_code}`) et le même
  `exec 9<>stdin` qui garde une session interactive vivante entre deux tours — portée depuis
  l'agent de nœud Cloud dans `lib/worker-commands.ts` ;
- l'**ingestion par curseur** : un offset en octets par commande, avancé par compare-and-swap,
  `seq` dense par tâche, les lignes du harnais gardées en `source` ;
- **répondre** (dans le stdin vivant si la session écoute, sinon reprise `--resume` sur l'id lu
  dans le flux), **interrompre** (`control_request/interrupt`), le **nom** que la session se
  donne (demandé à la session, ou lu une fois dans son transcript), l'**usage** (contexte, tokens, coût venu du harnais),
  les **pièces jointes** dans les deux sens (déposées dans le worker, affichées si ce sont des
  images raster, téléchargées sinon), le **diff** lu avec git dans la machine ;
- les **apps d'agent** : mêmes runners, mêmes features, mêmes catalogues et même validation —
  tout vient de `@spunto/build/agent-runners` ;
- les **réglages** : mêmes noms de champs que Cloud et que la spec portable. La spec ne porte
  pas `agentAppIds` (l'export de Cloud non plus) : un projet importé démarre sur Claude Code.

## Ce qui diffère, et pourquoi

| | Cloud | Lite |
|---|---|---|
| Routes | `/api/orgs/{orgId}/projects/{projectId}/tasks/{taskId}/…` | `/api/tasks/{taskId}/…` à plat, comme `/api/workers/{id}` ; création et liste d'un projet sous `/api/projects/{id}/tasks` |
| Jobs | table `platform_jobs` durable | en mémoire, dans le process, comme le spawn d'un worker |
| `pendingAction` | dérivé des jobs vivants | écrit sur la ligne, effacé en `finally` |
| Redémarrage pendant un job | le job reprend | au boot (`recoverInterruptedTasks`) : le lancement d'une tâche encore `queued` reprend, un Drop en vol est terminé, un Accept ou une réponse en vol est effacé avec une note |
| Répondre à une tâche `failed` | la sandbox lui appartient seule | le worker a pu passer à une autre tâche : les deux conversations le partagent, et aucun parquage ne l'arrête sous celle qui travaille |
| Machine arrêtée sous une session | `failed` | `in-review` si la conversation peut être reprise (voir « Un ordinateur qui redémarre ») |
| Verrou du pool | advisory Postgres | chaîne de promesses par worker (un seul process) |
| Pool | par membre | par projet (un seul utilisateur) |
| Consigne d'agent | celle de l'org + celle du projet | la phrase par défaut + celle du projet |
| Consigne par défaut | « this sandbox is deleted once the task is accepted or dropped… » | « this worker goes to another task… and its checkout is reset then… » : la machine est recyclée, pas détruite |
| Avant la session | rien (une sandbox par tâche) | rien sur une machine neuve ; « Workspace reset » sur une machine recyclée |
| Base de la tâche | ignorée avec `fromSnapshot` (chip masqué) | pas de snapshot ; ignorée sans dépôt (chip masqué) |
| Apps d'agent | installées par l'org (Integrations), désinstallation refusée tant qu'un projet s'en sert | toujours offertes, sans installation |
| Mémoire du compositeur | dernier harnais/modèle/paramètres du membre par projet | aucune : le défaut du projet |
| Diff indisponible | `no-machine`, `machine-stopped`, `node-unreachable`, `unsupported` | les deux premiers seulement : un seul démon Docker |
| Pull request | plus de panneau « PR de la branche » (`7f1b709d`) : une PR partagée dans la conversation passe par le bloc embed de l'app GitHub (état, checks, revue) | reconnue parmi les liens de la conversation, le lien seulement — Lite ne parle à aucune forge |
| Historique CPU / mémoire | battements des sandboxes, relus dans OpenObserve | `docker stats` échantillonné par Lite toutes les 30 s, dans SQLite, 7 jours |
| Bloc du harnais (Claude Code) | dessiné par l'app `claude` (`embed.taskTile`) | dessiné par Lite, mêmes lignes, même forme — pas d'intégrations |

**La session, elle, survit à un redémarrage de Lite** : c'est un process dans le worker, pas
dans le plan de contrôle. Le redémarrage ne perd que ce qui vivait en mémoire — une allocation en
cours, un Accept en cours.

**Les réglages de tâche ne créent pas de version**, sauf la liste des harnais. Un modèle, une
consigne ou une commande d'Accept n'entrent pas dans l'image et ne doivent pas marquer tous les
workers comme périmés : `updateProject` les applique sans version. `agentAppIds`, lui, met une
feature dans l'image : la carte *Delegated work* ne l'envoie que s'il a bougé, et c'est alors
une nouvelle version.

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
| `agentAppIds` | `["claude"]` à la création | les apps dont les tâches peuvent se servir, la première par défaut — **versionné** (dans l'image) |
| `taskAgentModels` | le défaut de chaque app | `{ "claude": "claude-opus-5-5" }` — un par app autorisée, vérifié contre son catalogue ; une tâche peut le surclasser |
| `taskValidateCommand` | Accept clôt la tâche | lancée par Accept dans le worker ; exit 0 ⇒ `done` |
| `taskCancelCommand` | rien de plus que tuer la session | nettoyage lancé par Drop |
| `taskReviewMode` | `keep` | `stop` : le conteneur est garé en revue (Park automatique), réveillé par Accept/Drop/une réponse/Wake |
| `taskReviewParkAfterMinutes` | `0` | avec `stop` : minutes en revue, machine debout, avant le parquage (§ « Garer plus tard ») |
| `taskAgentInstructions` | rien | ajouté à la consigne de chaque tâche du projet |

Ils se règlent dans le formulaire du projet, page **Agents** (section *Delegated work*, à côté des
serveurs MCP), comme dans Spunto Cloud, et s'enregistrent avec le reste du formulaire, à la
création comme à l'édition.

`taskResetCommand` a disparu comme dans Cloud (2026-10-26) : le checkout est déjà remis à plat
(« Workspace reset ») sur une machine recyclée.

Variables fournies aux commandes : `SPUNTO_TASK_ID`, `SPUNTO_TASK_TITLE`,
`SPUNTO_TASK_BASE_BRANCH`, `SPUNTO_TASK_STATE`, `SPUNTO_TASK_MODEL` (si résolu),
`SPUNTO_TASK_BRANCH` (seulement pour une tâche d'avant la RFC 0056 — sinon
`$(git branch --show-current)`), `SPUNTO_TASK_METADATA` et `SPUNTO_TASK_LINKS` (JSON, si la
tâche en porte), plus les secrets du projet **tels qu'ils sont maintenant**
(l'environnement du conteneur date de son spawn).

## Routes

```
GET    /api/tasks                               — toutes les tâches (?state=&q=&projectId=&metadata[clé]=&limit=&offset=), compteurs par état hors filtre d'état
GET    /api/projects/:id/tasks                  — celles d'un projet (?metadata[clé]=)
POST   /api/projects/:id/tasks                  — délègue { prompt, title?, baseBranch?, model?, agentAppId?, agentOptions?, files?, links?, metadata? } → 201, queued
GET    /api/tasks/:taskId                       — détail, re-dérivé, + canResume
PATCH  /api/tasks/:taskId                       — { title?, links?, metadata? } : renomme (rien d'autre ne bouge), remplace les liens, fusionne les métadonnées
DELETE /api/tasks/:taskId                       — oublie une tâche finie (409 si vivante)
GET    /api/tasks/:taskId/commands              — ce que la plateforme a lancé, plus ancien d'abord
GET    /api/tasks/:taskId/events                — la session (?since= | ?tail=true | ?before=, &limit=, &source=true) + usage + draft
GET    /api/tasks/:taskId/diff                  — ce que la tâche a changé depuis sa base, par dépôt
GET    /api/tasks/:taskId/diff/patch            — le patch d'un fichier (?path=&repo=&oldPath=&untracked=)
POST   /api/tasks/:taskId/messages              — répond { prompt, files? } → 202
POST   /api/tasks/:taskId/interrupt             — arrête le tour en cours sans tuer la session → 202
POST   /api/tasks/:taskId/validate              — Accept → 202
POST   /api/tasks/:taskId/cancel                — Drop → 202
POST   /api/tasks/:taskId/park                  — gare la machine d'une tâche en revue (409 sinon, ou pendant une action en vol)
POST   /api/tasks/:taskId/wake                  — rallume la machine garée d'une tâche en revue
POST   /api/tasks/:taskId/keep-awake            — annule le parquage programmé (`parkAt`) d'une tâche en revue (409 sinon)
GET    /api/workers/:id/machine-ports           — les ports d'un worker : déclarés (label, chemin) et à l'écoute
GET    /api/tasks/:taskId/attachments/:id       — les octets d'une pièce jointe (PNG/JPEG/WebP/GIF inline, le reste en téléchargement)
GET    /api/tasks/:taskId/shared                — les liens et fichiers de la conversation { links, files }
GET    /api/tasks/:taskId/tiles                 — les blocs Claude Code et Pull requests (TaskAppTile[])
GET    /api/workers/:id/metrics                 — l'historique CPU / mémoire d'un worker (?range=1h|6h|24h|7d)
GET    /api/agent-apps                          — les apps d'agent et leur catalogue (modèles, paramètres)
```

## Où c'est implémenté

| Fichier | Rôle |
|---|---|
| `db/schema.ts` | tables `tasks`, `task_commands`, `task_events`, `task_attachments`, `worker_samples`, colonnes `projects.task_*` |
| `services/tasks.ts` | création, allocation, remise à plat d'une machine recyclée, session, dérivation, plancher de fond, Accept/Drop/réponse/interruption |
| `services/task-commands.ts` | ce qui a tourné pour une tâche, et sa réconciliation avec le worker |
| `services/task-events.ts` | ingestion par curseur, titre de session, usage, brouillon en mémoire |
| `services/task-diff.ts`, `lib/task-diff.ts` | le diff lu avec git dans le worker (scripts et parseurs repris de Cloud) |
| `services/task-attachments.ts`, `lib/task-attachments.ts` | pièces jointes dans les deux sens |
| `services/task-shared.ts`, `lib/task-shared.ts`, `lib/claude-tile.ts` | ce qui a circulé (liens, fichiers), les PR parmi les liens, le bloc Claude Code |
| `services/worker-metrics.ts`, `components/worker-metrics-history.tsx` | l'échantillonnage CPU / mémoire des workers et son graphique |
| `lib/worker-commands.ts` | commandes foreground/background dans un worker (port de l'agent de nœud Cloud) |
| `lib/agent-apps.ts` | les apps d'agent : `effectiveFeatures`, `resolveTaskAgentApp`, `resolveAgentOptions`, `taskHarness`, `LEGACY_CLI` |
| `app/(app)/agents/page.tsx` | le poste de pilotage |
| `components/task-cockpit.tsx` | une conversation — les données ; tout ce qui dessine vient du design system |
| `components/task-machine-controls.tsx` | Park / Wake / Keep awake (et le compte à rebours) sous la section Machine du cockpit |
| `lib/ports.ts`, `hooks/use-machine-ports.ts` | les ports nommés : validation, fusion déclarés/à l'écoute, liens avec chemin |
| `components/task-panel.tsx`, `components/new-task-button.tsx`, `components/task-settings-card.tsx` | la section du projet, la délégation, les réglages |
| `lib/task-cache.ts`, `hooks/use-task-actions.ts` | les trois caches d'une tâche gardés d'accord, et les actions |
| `e2e/tests/tasks.spec.ts` | l'API sans Docker (validation, refus, formes) — tourne en CI |
| `e2e/tests/tasks-lifecycle.spec.ts` | bout en bout sur vrai conteneur, sans forge ni clé d'API (`E2E_DOCKER=1`) |
| `e2e/fixtures/fake-claude.js` | un faux Claude Code qui parle le vrai `stream-json` interactif |
