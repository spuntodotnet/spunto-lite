---
title: "Tâches d’agent"
description: "Déléguer un travail à Claude Code, Codex ou Mistral Vibe dans un espace de travail jetable, le suivre en direct, relire le diff, puis l’accepter ou l’abandonner."
group: agents
order: 1
---

Une **tâche** est une unité de travail confiée à un agent de code — « corriger la connexion qui
casse sous Safari ». Elle reçoit un worker du pool du projet et une session d’agent dans ce worker,
et elle se termine par quelque chose à relire. C’est la fonctionnalité *Agents* de Spunto Cloud, sur
votre propre machine : même modèle, mêmes états, mêmes écrans.

## Avant la première tâche

Un projet a besoin de deux choses :

1. **Une application d’agent activée**, dans **Agents → Delegated work → Harness** du formulaire du
   projet (le harnais). Un nouveau projet démarre avec Claude Code. Plusieurs peuvent être
   activées ; la première est celle par défaut, **Make default** en promeut une autre.
2. **La clé de l’application, sous forme de [secret](/fr/docs/secrets)** — global ou propre au
   projet :

| Application | Repose sur | Secret |
|---|---|---|
| **Claude Code** | le Claude Agent SDK officiel | `ANTHROPIC_API_KEY` |
| **Codex** | le Codex SDK officiel | `OPENAI_API_KEY` ou `CODEX_API_KEY` |
| **Mistral Vibe** | `vibe-acp`, piloté via ACP | `MISTRAL_API_KEY` |

C’est tout — **aucun dépôt n’est requis**. Sans dépôt, la session s’exécute dans `/workspace` ;
avec un dépôt, dans le premier, cloné avec votre clé SSH.

Chaque application activée ajoute son SDK à l’image du projet (un Node privé sous
`/opt/spunto/agents`, plus la CLI dans le `PATH`, pour vous, dans le terminal). Modifier la liste
crée donc une nouvelle version et un rebuild, comme modifier une feature.

## Déléguer

**New task** sur un projet, ou **Agents → New** dans la barre latérale. Écrivez ce que vous voulez,
puis choisissez :

- le **harnais** (l’une des applications du projet), son **modèle**, et les paramètres que cette
  application déclare — *effort* pour Claude Code, *reasoning effort* et *web search* pour Codex ;
- éventuellement une **branche de base** : la branche que le worker clone, et celle sur laquelle
  une machine recyclée est réinitialisée. Vide, c’est la branche par défaut du dépôt.

Vous pouvez joindre des fichiers au message ; ils sont déposés dans le worker.

## Suivre et orienter

La page de la tâche comporte trois onglets :

- **Session** — la conversation, avec la réponse de l’agent qui s’affiche au fur et à mesure de
  son écriture, ses appels d’outils, et une zone de réponse : **répondez**-lui, ou
  **interrompez** le tour sans tuer la session.
- **Diff** — ce qui a changé, lu avec git dans la machine elle-même, par rapport à la merge-base
  de la branche de base, quelle que soit la branche créée par l’agent.
- **Terminal** — un shell dans la machine de la tâche, sur le checkout tel que l’agent l’a laissé.
  Ce sont les mêmes sessions persistantes que sur la page du worker ; la session propre de l’agent
  n’en fait jamais partie.

La colonne de détails réunit les faits sur la tâche : la machine (sa page, ses ports nommés,
Park / Wake), les chiffres de la session (contexte, tokens, coût, tours), ce que Claude Code
rapporte sur lui-même (quota du forfait, serveurs MCP, skills…), les pull requests et liens partagés
dans la conversation, le prompt, et l’historique CPU / mémoire.

La page **Agents** liste toutes les conversations de tous les projets, regroupées selon ce qui
attend une action de votre part.

## États

| État | Signification |
|---|---|
| `queued` | en attente de sa machine — allocation, build de l’image, démarrage, réinitialisation d’une machine recyclée |
| `running` | la session de l’agent travaille |
| `in-review` | elle a rendu la main proprement : il y a quelque chose à juger |
| `done` | acceptée — **uniquement** par un clic |
| `failed` | la session est morte de façon anormale, aucune machine n’a pu être obtenue, ou la tâche a été abandonnée |

Un tour qui se termine alors que du travail tourne encore en arrière-plan (une commande en
arrière-plan, un sous-agent) n’est pas un rendu de main : la tâche reste `running` jusqu’à ce que
la session rende vraiment la main. Si le processus de la session meurt après un tour terminé, la
tâche reste en revue et une réponse reprend la conversation.

## Accept et Drop

- **Accept** exécute la **commande d’acceptation** du projet (*accept command*), s’il en a une,
  dans le worker de la tâche — par exemple `git push origin "$(git branch --show-current)"`, ou un
  script qui ouvre une pull request. Code de sortie 0 ⇒ `done`. Sans commande, Accept se contente
  de clore la tâche.
- **Drop** tue la session, exécute la **commande d’abandon** du projet (*drop command*) s’il y en
  a une (nettoyage), et marque la tâche `failed` (« Cancelled »).

Les deux commandes reçoivent `SPUNTO_TASK_ID`, `SPUNTO_TASK_TITLE`, `SPUNTO_TASK_BASE_BRANCH`,
`SPUNTO_TASK_STATE`, `SPUNTO_TASK_MODEL`, `SPUNTO_TASK_METADATA` / `SPUNTO_TASK_LINKS` (JSON,
lorsqu’elles sont définies), et les secrets du projet **tels qu’ils sont à ce moment-là**.

## Aucun git imposé

Lite ne crée pas de branche pour une tâche. La session démarre sur le checkout tel que le worker
l’a cloné ; l’agent crée une branche s’il en veut une, et la nomme. Ce que Lite lui indique, c’est
un fait : ce worker passera à une autre tâche une fois celle-ci acceptée ou abandonnée, et son
checkout sera alors réinitialisé — tout ce qui mérite d’être gardé doit en sortir avant (pour du
code : le commiter sur une branche, et la pousser).

## Le pool, et les machines recyclées

Le worker d’une tâche vient du **pool** du projet — les workers étiquetés `task`. Un worker libre
est réutilisé (redémarré s’il était arrêté) ; sinon, un nouveau est créé. Un worker que vous avez
créé à la main n’est jamais pris.

Le worker appartient à la tâche jusqu’à ce qu’elle soit `done` ou `failed` ; il retourne alors au
pool **garé** (arrêté, disque conservé), après un rebuild s’il était en retard sur la version du
projet. La tâche suivante le redémarre en quelques secondes.

Avant que la session ne démarre sur une machine **recyclée**, Lite exécute **Workspace reset**
dans chaque dépôt : il montre ce qui va être jeté, puis `reset --hard`, `clean -fd` (jamais `-x` :
les fichiers ignorés comme `node_modules` sont justement l’intérêt du recyclage), `fetch` et
`checkout -B <base> origin/<base>`. Une machine neuve saute cette étape.

## Pendant la revue : garder ou garer

**Worker during review**, dans les réglages Delegated work du projet :

- **Keep** (par défaut) — la machine reste allumée pendant que vous relisez.
- **Park it** — le conteneur est arrêté quand la session rend la main, et réveillé par une
  réponse, Accept, Drop ou **Wake**. **Park after N minutes** (jusqu’à 1 440) le laisse d’abord
  allumé un moment, avec un compte à rebours sur le panneau Machine et un bouton **Keep awake** ;
  répondre annule le compte à rebours.

**Park** et **Wake** figurent aussi sur le panneau Machine de toute tâche en revue.

## Réglages du projet

| Réglage | Par défaut | |
|---|---|---|
| Harness | Claude Code | les applications que les tâches peuvent utiliser, la première par défaut — fait partie de l’image |
| Default model | celui de l’application | un par application ; une tâche peut le remplacer |
| Accept command | aucune | exécutée par Accept ; sortie 0 ⇒ done |
| Drop command | aucune | nettoyage exécuté par Drop |
| Worker during review | Keep | ou Park it, tout de suite ou après N minutes |
| Instructions | aucune | ajoutées à la consigne permanente de chaque tâche |

Hormis le harnais, aucun de ces réglages n’entre dans l’image : les modifier ne crée pas de
version.

## Serveurs MCP

Les tâches reçoivent les serveurs MCP activés pour leur projet — Notion, Linear, les vôtres — via
la passerelle de Lite, sans que le worker détienne jamais le jeton de l’éditeur. Voir
[Serveurs MCP](/fr/docs/mcp-servers).
