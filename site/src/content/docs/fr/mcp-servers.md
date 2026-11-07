---
title: "Serveurs MCP"
description: "Déclarer des serveurs MCP une fois, les connecter en OAuth depuis Settings, et les fournir aux tâches d’agent de vos projets via la passerelle de Lite."
group: agents
order: 2
---

Déclarez un serveur MCP par son URL, connectez-vous-y depuis **Settings**, et les sessions de vos
[tâches d’agent](/fr/docs/agents) — Claude Code, Codex comme Mistral Vibe — le reçoivent sans une
ligne de configuration dans le dépôt. La session ne voit jamais le serveur ni le jeton de
l’éditeur : elle appelle la **passerelle** de Lite avec le jeton propre à sa tâche, et Lite relaie
l’appel avec le jeton qu’il détient.

## Déclarer un serveur

**Settings → MCP servers → Add**, avec l’URL du serveur. Lite lui envoie un `initialize` sans jeton
et en déduit son mode d’authentification :

| Auth | Quand |
|---|---|
| **none** | le serveur répond |
| **OAuth** | il répond `401` et annonce des métadonnées OAuth |
| **header** | vous avez fourni un en-tête (une clé d’API) — obligatoire si le serveur exige un identifiant sans annoncer OAuth. Le nom et la valeur sont stockés chiffrés |

## Se connecter en OAuth

**Connect** ouvre la page de consentement de l’éditeur. Le client OAuth est soit enregistré
automatiquement (Dynamic Client Registration) à la première connexion, soit — quand l’éditeur ne le
prend pas en charge — un client que vous avez enregistré vous-même (*« I registered a client
myself »*), avec l’URI de redirection :

```text
http://localhost/api/mcp/oauth/callback
```

(`localhost` étant l’origine à laquelle vous ouvrez Lite.) PKCE, indicateurs de ressource et
vérifications de l’émetteur sont gérés pour vous. **Reconnect** apparaît quand une connexion doit
être réautorisée ; **Disconnect** oublie les jetons, avec effet dès l’appel suivant.

## Par projet

Chaque serveur a un **mode**, l’interrupteur de sa ligne dans Settings :

- **default** — fourni aux tâches de tous les projets, sauf si un projet le désactive ;
- **optional** — fourni uniquement aux projets qui l’activent.

Un projet s’écarte du mode dans **Agents → MCP servers** de son formulaire. Ce réglage est en
dehors de la configuration versionnée : pas de nouvelle version, pas de rebuild — il s’applique à
la session suivante.

## Dans la session

À chaque démarrage de session (premier tour et chaque reprise), la session reçoit la liste des
serveurs de son projet, chacun sous la forme d’un chemin sur la passerelle de Lite, et un jeton
neuf limité à la tâche. Le runner en tire la configuration MCP propre au harnais. Un serveur dont la
connexion OAuth n’est pas valide est laissé de côté : mieux vaut une session sans l’outil qu’une
session avec un outil cassé.

La passerelle refuse un jeton dont le projet a désactivé le serveur.
