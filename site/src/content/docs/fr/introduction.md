---
title: "Introduction"
description: "Ce qu’est Spunto Lite, ce sur quoi il tourne, et comment cette documentation est organisée."
group: start
order: 1
---

**Spunto Lite** est un plan de contrôle local pour environnements de développement. C’est un seul
conteneur qui dialogue avec le démon Docker de votre machine : vous décrivez une fois un **projet**
— une image de base, des features devcontainer, les dépôts à cloner, des ports, des hooks de cycle
de vie, des secrets — et vous en lancez des **workers** jetables. Chaque worker est un conteneur
Docker avec **VS Code dans le navigateur** (code-server) sur son propre sous-domaine, un
**terminal persistant** et **votre propre clé SSH**, pour que `git clone` et `git push`
fonctionnent sans autre réglage.

Par-dessus, Lite peut confier un worker à un **agent de code** — Claude Code, Codex ou Mistral
Vibe — et vous laisser relire ce qu’il a fait avant de l’accepter.

C’est le pilier *Build* de [Spunto](https://spunto.net), ramené sur une seule machine. Il est
publié sous licence MIT, et l’image est publique sur GitHub Container Registry.

## Ce qu’il vous faut

- **Docker** — Docker Desktop sur macOS ou Windows, Docker Engine sur Linux — avec son socket à
  `/var/run/docker.sock`.
- **Le port 80 libre** sur l’hôte. Un autre port fonctionne aussi, au prix d’un `:port` dans
  chaque URL.
- Un navigateur. `*.localhost` se résout tout seul vers `127.0.0.1` dans Chrome, Edge et Firefox :
  aucun DNS à configurer.
- Éventuellement, une clé SSH dans `~/.ssh` acceptée par votre hébergeur git.

L’image est publiée pour `linux/amd64` et `linux/arm64` (Apple Silicon compris).

## Le vocabulaire

| Terme | Signification |
|---|---|
| **Projet** | Une spécification à la manière des devcontainers : image de base, features, extensions, dépôts, ports, hooks, secrets. Versionné. |
| **Worker** | Un conteneur construit à partir d’un projet : un volume `/workspace` privé, code-server, des terminaux. Jetable. |
| **Build d’image** | L’image du projet, construite une fois par version et réutilisée par tous les workers de cette version. |
| **Service** | Un conteneur partagé et durable (Postgres, Redis…) que chaque worker joint par son nom. |
| **Secret** | Une valeur chiffrée injectée comme variable d’environnement — globale, ou propre à un projet. |
| **Tâche** | Un travail délégué à un agent, dans un worker du pool du projet, qui se termine par une revue. |

## Le fonctionnement, en un paragraphe

Un unique processus Next.js sert le tableau de bord et fait office de reverse proxy pour les
sous-domaines des workers. Il pilote Docker par le socket uniquement pour le **cycle de vie** des
workers — créer, démarrer, arrêter, supprimer, construire. Dans chaque worker tourne un petit
**agent** (le même que dans une sandbox Spunto Cloud) qui se reconnecte à Lite par un WebSocket et
transporte tout le reste : commandes, terminaux, ports en écoute, avancement de l’installation.
Projets, workers et secrets sont stockés dans **SQLite**, dans un seul volume Docker. Rien ne
quitte votre machine.

## Pour continuer

- [Installation](/fr/docs/installation) — le lancer, avec `docker run` ou compose.
- [Démarrage rapide](/fr/docs/quick-start) — d’un tableau de bord vide à un éditeur en trois
  minutes.
- [Agents](/fr/docs/agents) — déléguer une tâche à Claude Code, Codex ou Mistral Vibe.
- [Sécurité](/fr/docs/security) — à lire avant d’exposer Lite à autre chose que `localhost`.
