---
title: "Workers"
description: "La vie d’un espace de travail — ses états, son IDE et son terminal, ses ports et URL, et ce que conservent l’arrêt, le rebuild, la mise à jour et la suppression."
group: use
order: 2
---

Un **worker** (un *workspace* dans le tableau de bord) est un conteneur Docker construit à partir
d’un projet, avec son propre volume `/workspace`, son propre réseau, un IDE et des terminaux. Il est
fait pour être jetable : lancez-en un par branche, par expérience, par agent, et supprimez-le quand
vous avez fini.

## En lancer un

**New workspace** sur la page du projet. Vous pouvez le nommer et choisir une **branche** à extraire
dans chaque dépôt ; sinon, la branche par défaut de chaque dépôt est utilisée. La branche est
mémorisée, pour qu’un rebuild extraie la même.

## États

| État | Signification |
|---|---|
| `provisioning` | la ligne existe, rien n’a encore démarré |
| `building` | l’image du projet est en cours de construction (une seule fois par version — les workers suivants la réutilisent) |
| `starting` | le conteneur est lancé et l’installation s’exécute : clonage, features, `postCreateCommand`, `postStartCommand` |
| `ready` | installation terminée — l’IDE et le terminal sont disponibles |
| `stopped` | arrêté par vous ; le disque est conservé |
| `error` | l’installation a échoué (la page du worker indique à quelle étape), ou le conteneur est mort de lui-même (avec le code de sortie ou le message du démon) |

L’état est lu dans Docker et dans le fichier de statut de l’installation à chaque consultation : il
ne peut donc pas s’écarter de la réalité.

## L’IDE

**Open IDE** ouvre code-server — VS Code dans le navigateur — à `http://worker-<id>.localhost`, sur
`/workspace`, avec les extensions du projet installées. Il porte la marque *Spunto*, avec un thème
*Spunto Light* par défaut et *Spunto Dark* disponible ; un `settings.json` déjà présent dans
l’espace de travail n’est jamais écrasé.

## Le terminal

L’onglet **Terminal** de la page du worker vous donne des shells persistants, en onglets. La
persistance vient de dtach plutôt que d’un multiplexeur :

- fermer l’onglet du navigateur ne tue pas ce qui y tourne — un build, un serveur de
  développement, un REPL ;
- revenir vous rattache à la même session et rejoue la fin de sa sortie ;
- comme c’est le navigateur qui dessine, la molette fait défiler l’historique, et la sélection de
  texte et la recherche fonctionnent comme dans n’importe quelle page web.

Les sessions sont listées et fermées depuis la barre d’onglets. Ce sont les mêmes sessions que
celles de l’onglet Terminal d’une tâche.

## URL

| Quoi | URL |
|---|---|
| IDE | `http://worker-<id>.localhost` |
| un port | `http://worker-<id>-<port>.localhost` — tout port en écoute, déclaré ou non |
| un service partagé | `http://svc-<slug>.localhost` |

`localhost` correspond à la valeur de `BASE_DOMAIN` — voir [Configuration](/fr/docs/configuration).
Dans le worker, `WORKER_SLUG` et `BASE_DOMAIN` sont définies, pour qu’une application puisse
construire sa propre URL publique.

## Arrêter, démarrer, reconstruire, mettre à jour, supprimer

| Action | Ce qui se passe | `/workspace` |
|---|---|---|
| **Stop** | le conteneur s’arrête | conservé |
| **Start** | il redémarre ; `postStartCommand` s’exécute | conservé |
| **Rebuild** | le conteneur est recréé sur la même version ; `postCreateCommand` s’exécute de nouveau | conservé |
| **Update to vN** | recréé sur la dernière version du projet | conservé |
| **Delete** | conteneur, réseau et volume supprimés | **perdu** |

Les fichiers hors de `/workspace` (et hors des volumes partagés du projet) vivent dans le conteneur
et ne survivent ni à un rebuild ni à une mise à jour — installez vos outils par des features ou des
hooks, pas à la main.

## Surveiller un worker

La page du worker affiche les étapes de l’**installation** au fil de leur exécution, les **logs** du
conteneur, le **CPU et la mémoire** en direct (avec un court historique), et l’état git de chaque
dépôt. La page **Resources** liste chaque conteneur, image et volume que possède Lite, avec sa
taille — c’est là qu’on voit ce qui occupe le disque.

## Étiquettes

Les workers peuvent porter des étiquettes (*tags*). Lite en utilise une lui-même : `task` marque les
workers qui forment le pool d’un projet pour les [tâches d’agent](/fr/docs/agents). Un worker sans
cette étiquette est à vous, et une tâche ne le prend jamais.

## Environnement d’un worker

Chaque worker reçoit, comme variables d’environnement :

- les [secrets](/fr/docs/secrets) globaux, puis ceux du projet (un secret de projet l’emporte sur un
  secret global du même nom) ;
- `SPUNTO_SVC_<SLUG>`, `_HOST` et `_PORT` pour chaque [service partagé](/fr/docs/shared-services) ;
- `SSH_AUTH_SOCK`, qui pointe vers le socket d’agent SSH servi par Lite ;
- `WORKER_SLUG` et `BASE_DOMAIN`.

Elles sont définies à la création du conteneur : un secret ajouté plus tard n’atteint un worker
qu’après un **Rebuild**.
