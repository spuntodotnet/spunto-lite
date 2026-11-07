---
title: "Projets"
description: "La spécification dont un espace de travail est construit — image, features, extensions, dépôts, hooks, ports — et le fonctionnement des versions, des modèles et de l’export."
group: use
order: 1
---

Un **projet** décrit un environnement, dans le vocabulaire de la
[spécification devcontainer](https://containers.dev) : quoi construire, quoi cloner, quoi exécuter.
Chaque worker du projet est construit à partir de lui. Le formulaire est découpé en pages — les
mêmes que dans Spunto Cloud :

| Page | Contient |
|---|---|
| **General** | nom et description, image de base, dépôts |
| **Tooling** | features devcontainer, extensions VS Code |
| **Lifecycle** | `postCreateCommand`, `postStartCommand` |
| **Runtime** | ports nommés, Docker dans l’espace de travail, volumes partagés |
| **Agents** | la façon dont s’exécutent les tâches déléguées, et les serveurs MCP qu’elles reçoivent |
| **Secrets** | les secrets du projet |

## Image de base

N’importe quelle image que Docker peut récupérer : une
[image devcontainer](https://github.com/devcontainers/images), une image officielle de langage, ou
la vôtre. L’image de l’espace de travail est votre image de base plus deux features devcontainer
que Lite ajoute toujours en premier —
[`common-utils`](https://github.com/devcontainers/features/tree/main/src/common-utils) (un
utilisateur `vscode`, un shell, l’essentiel) et
[`spunto-pack`](https://github.com/coderhammer/features/tree/main/src/spunto-pack) (code-server,
dtach, l’agent) — puis les features que vous déclarez.

Les images d’un **Google Artifact Registry ou GCR privé** se récupèrent avec une clé de compte de
service renseignée dans **Settings → Container registry** (rôle `roles/artifactregistry.reader`).
Les autres registres privés exigent que le Docker de l’hôte y soit connecté.

## Features et extensions

Les **features** sont des features devcontainer choisies dans un catalogue (Node, Python, Go,
Docker-in-Docker, la CLI GitHub…), chacune avec ses options et une version facultative. Elles sont
installées dans l’image, dans l’ordre, au moment du build.

Les **extensions** sont des identifiants d’extensions VS Code (`dbaeumer.vscode-eslint`),
recherchés par défaut sur [Open VSX](https://open-vsx.org) et préinstallés dans l’image. Pour
utiliser une autre galerie, voir [Configuration](/fr/docs/configuration#galerie-des-extensions).

## Dépôts

Un dépôt est une **URL de clonage**, exactement telle que `git clone` l’accepte — SSH
(`git@gitlab.example.com:team/app.git`) ou HTTPS — plus l’emplacement où le cloner sous
`/workspace`. Il n’y a aucune intégration de forge : pas d’application à installer, pas de jeton à
générer. Tout ce que votre clé SSH atteint fonctionne de la même façon — voir
[Clés SSH et git](/fr/docs/ssh-and-git).

Un projet peut avoir plusieurs dépôts, ou aucun : un espace de travail sans dépôt n’est qu’un
environnement.

## Hooks de cycle de vie

| Hook | S’exécute |
|---|---|
| `postCreateCommand` | une fois, à la création de l’espace de travail — et de nouveau lors d’un rebuild |
| `postStartCommand` | à chaque démarrage de l’espace de travail |

Les deux s’exécutent en tant qu’utilisateur `vscode`, dans l’espace de travail, avec dans
l’environnement les secrets du projet et les adresses des services partagés. Leur sortie constitue
le journal d’**installation** (*setup*) du worker ; un hook en échec fait passer le worker en
`error`, avec l’étape à laquelle il s’est arrêté.

## Ports

Tout port en écoute dans un worker est accessible à `http://worker-<id>-<port>.localhost` sans
avoir été déclaré. En déclarer un sous **Runtime → Ports** lui donne un **libellé** (`Web app`) et
un **chemin d’arrivée** (`/dashboard`), utilisés par les liens qu’affiche Lite — sur le panneau
Machine d’une tâche, un port déclaré est vert tant que quelque chose écoute dessus, et grisé sinon.

## Docker dans l’espace de travail

**Runtime → Docker** active Docker-in-Docker pour les workers du projet (le modèle du même nom
l’active d’emblée), de sorte que `docker compose up` fonctionne dans un espace de travail, isolé du
démon de votre hôte.

## Volumes partagés

Des volumes montés dans **tous** les workers du projet, en plus du `/workspace` privé de chacun —
un cache de paquets, un jeu de données. Voir [Volumes partagés](/fr/docs/shared-volumes).

## Versions

Enregistrer une modification de tout ce qui entre dans l’image (image, features, extensions,
dépôts, hooks, harnais d’agents…) crée une **nouvelle version** et construit son image en
arrière-plan, pour que le lancement suivant soit déjà chaud. Les noms, descriptions et libellés de
ports, eux, n’en créent pas.

- Les workers existants continuent de tourner sur la version à partir de laquelle ils ont été
  construits ; leur carte propose **Update to vN**, qui recrée le conteneur sur la nouvelle
  configuration et **conserve `/workspace`** — fichiers et travail non commité compris.
- La page du projet liste les versions passées ; **Restore** rend de nouveau courante une
  ancienne version (sous la forme d’une nouvelle version).
- Le journal d’un build d’image s’ouvre depuis la page du projet, et suit le build en direct
  pendant qu’il tourne.

## Modèles

**New project → From a template** préremplit le formulaire pour Next.js, Vite + React, Astro,
FastAPI, Express et Docker-in-Docker. Rien ne lie ensuite le projet à son modèle.

## Export et import

**Export** sur un projet télécharge sa spécification en JSON (`GET /api/projects/:id/export`).
**Import**, sur le tableau de bord ou dans le formulaire de nouveau projet, préremplit le
formulaire à partir d’un tel fichier. Les **valeurs** des secrets ne sont jamais exportées —
seulement leurs noms, pour que le formulaire prépare les lignes à remplir.

Le format est celui que partage Spunto Cloud (le format de projet portable de `@spunto/build`) :
un projet passe donc de Lite à Cloud, ou l’inverse, en l’exportant de l’un et en l’important dans
l’autre.

## Supprimer un projet

Supprimer un projet supprime ses workers, ses images et ses volumes partagés, après une
confirmation explicite — les volumes partagés contiennent des données qu’aucun rebuild ne fait
revenir.
