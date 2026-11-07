---
title: "Démarrage rapide"
description: "D’un tableau de bord vide à un éditeur dans un espace de travail, en trois étapes."
group: start
order: 3
---

On suppose ici que Lite tourne et est ouvert à **http://localhost** — voir
[Installation](/fr/docs/installation).

## 1. Vérifier votre clé SSH

Ouvrez **Settings**. Lite liste les clés trouvées dans `~/.ssh` et indique celle qu’il donne aux
workers. Ajoutez la partie publique de cette clé chez votre hébergeur git (GitHub, GitLab, une forge
auto-hébergée…) si elle n’y est pas déjà : c’est le seul identifiant dont Lite se sert pour cloner
et pousser.

Une clé protégée par une phrase de passe affiche un badge *passphrase* : déverrouillez-la là une
fois, ou relayez l’agent de votre hôte — voir [Clés SSH et git](/fr/docs/ssh-and-git). Vous pouvez
sauter entièrement cette étape pour un projet sans dépôt.

## 2. Créer un projet

**Projects → New project**. Au choix :

- **partir d’un modèle** — Next.js, Vite + React, Astro, FastAPI, Express ou Docker-in-Docker
  (image de base, features et ports déjà renseignés), ou
- **remplir le formulaire** — un nom, une image de base (n’importe quelle image convient ; les
  [images devcontainer](https://mcr.microsoft.com/en-us/catalog?search=devcontainers) sont un bon
  point de départ, par exemple `mcr.microsoft.com/devcontainers/typescript-node:22`), et un dépôt
  par son URL de clonage, comme `git@github.com:you/app.git`.

Les hooks sont facultatifs : `postCreateCommand` s’exécute une fois, à la création d’un espace de
travail (installer les dépendances), `postStartCommand` à chaque démarrage (lancer le serveur de
développement). Enregistrer le projet crée la **version 1** et lance la construction de son image
en arrière-plan.

## 3. Lancer un espace de travail

Sur la page du projet, **New workspace**. Choisissez éventuellement une branche à extraire ; sinon,
la branche par défaut de chaque dépôt est utilisée. Le worker passe par `building` (seulement la
première fois pour une version donnée), `starting` (le script d’installation : clonage, features,
hooks) puis `ready`.

Ensuite :

- **Open IDE** — VS Code dans le navigateur à `http://worker-<id>.localhost`, ouvert sur
  `/workspace`.
- **Terminal** — l’onglet terminal de la page du worker. Il survit à la fermeture de l’onglet :
  revenez, et la session, avec son historique de défilement, est toujours là.
- **Ports** — tout ce qui écoute dans le worker est accessible à
  `http://worker-<id>-<port>.localhost`, déclaré ou non.

Quand vous avez fini, **Stop** conserve le disque de l’espace de travail pour plus tard ; **Delete**
supprime le conteneur et son volume.

## Et ensuite

- Modifiez le projet et relancez : une nouvelle version signifie une nouvelle image, et les workers
  existants proposent de se **mettre à jour** — voir [Projets](/fr/docs/projects).
- Partagez un seul Postgres entre tous vos projets : [Services partagés](/fr/docs/shared-services).
- Déléguez une modification à un agent et relisez-la : [Agents](/fr/docs/agents).
