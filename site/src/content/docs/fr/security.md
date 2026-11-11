---
title: "Sécurité"
description: "Ce à quoi Spunto Lite fait confiance, ce qu’il protège, et pourquoi il ne doit jamais être exposé sur Internet."
group: operate
order: 2
---

Lite est un **outil mono-utilisateur pour votre propre machine**. Son modèle de sécurité en
découle, et mieux vaut le connaître avant de l’exposer à quoi que ce soit d’autre.

## Il n’y a pas d’écran de connexion

Quiconque peut atteindre le port de Lite le contrôle — et Lite détient votre **socket Docker**.
Accéder au socket Docker revient, en pratique, à être root sur l’hôte : on peut démarrer un
conteneur avec le système de fichiers de l’hôte monté.

Donc :

- **Restez sur `localhost`**, ce à quoi revient le `-p 80:80` par défaut sur un portable derrière un
  pare-feu normal.
- Sur un **réseau de confiance** (le réseau local de votre domicile, un VPN comme Tailscale ou
  WireGuard), c’est à vous de juger.
- **Jamais sur Internet**, pas même « juste une minute », et pas derrière une redirection de port.
  Si vous en avez besoin à distance, placez-le derrière un VPN, ou derrière un proxy
  d’authentification que vous contrôlez.

Spunto Cloud est la version avec comptes, rôles et authentification devant chaque espace de
travail.

## Ce que peut faire un espace de travail

Un worker est un conteneur sur votre démon Docker, avec :

- **son propre réseau** (`mp-worker-<id>-net`), et ses propres ports, système de fichiers et clone ;
- le **réseau partagé**, sur lequel se trouvent chaque [service partagé](/fr/docs/shared-services)
  et chaque worker — un espace de travail joint votre Postgres partagé par conception, et peut
  aussi joindre un autre worker par son nom `worker-<id>`. Les espaces de travail sont isolés les
  uns des autres pour les *fichiers*, pas pour le réseau ;
- votre **clé SSH** (copiée dedans) ou, pour une clé protégée par phrase de passe, le **socket de
  l’agent**, qui signe tant que la clé est déverrouillée. Le code d’un worker peut pousser partout
  où votre clé le peut.
- les **secrets** de son projet et les secrets globaux, dans son environnement.

Une feature qui se déclare privilégiée dans ses métadonnées — c’est le cas de Docker-in-Docker —
fait tourner ses workers dans un conteneur **privilégié**.

## Agents

Un agent s’exécute avec tout ce dont dispose son worker : votre clé SSH, vos secrets, le réseau.
Lite garde hors de sa portée ce qu’il peut — les **jetons MCP** restent dans Lite, le worker ne
reçoit qu’un jeton pour la passerelle de Lite, limité à sa tâche — mais il ne peut pas rendre un
agent inoffensif. Avant de déléguer à un agent dont vous ne tenez pas le résultat pour fiable :

- ne donnez au projet que les secrets dont la tâche a besoin ;
- utilisez une clé de déploiement avec accès en écriture à ce seul dépôt, plutôt que votre clé
  personnelle ;
- **verrouillez** dans Settings une clé protégée par phrase de passe quand vous n’avez pas besoin
  qu’elle soit déverrouillée.

## Ce qui est stocké, et comment

- **Secrets** — chiffrés en AES-256-GCM avec `DATA_ENCRYPTION_KEY` ; définissez-en une vraie.
- **Une phrase de passe** — jamais stockée : la clé déchiffrée ne vit que dans la mémoire de
  l’`ssh-agent` propre à Lite, jusqu’à ce qu’elle soit verrouillée ou que Lite redémarre.
- **Connexions MCP** — jetons OAuth et valeurs d’en-têtes chiffrés dans la base.
- **Votre `~/.ssh`** — monté en lecture seule.

## Télémétrie

Aucune. Lite n’envoie rien chez lui. Le seul trafic sortant est celui que vous provoquez :
récupération d’images et de features, la galerie d’extensions, vos remotes git, les fournisseurs de
vos agents et vos serveurs MCP.

## Signaler une vulnérabilité

Merci de la signaler en privé, via les
[security advisories de GitHub](https://github.com/spuntodotnet/spunto-lite/security/advisories/new)
du dépôt, plutôt que dans une issue publique.
