---
title: "Volumes partagés"
description: "Monter un cache de paquets, un jeu de données ou des artefacts de build dans chaque espace de travail d’un projet — et ce que cela garantit ou non."
group: use
order: 6
---

Chaque worker reçoit son propre volume `mp-worker-<id>-workspace` sur `/workspace`. Deux workers du
même projet téléchargent donc leurs dépendances et régénèrent leurs artefacts chacun de leur côté.
Un projet peut déclarer des **volumes partagés** pour l’éviter.

## En déclarer un

Dans le formulaire du projet, **Runtime → Shared volumes** : un nom et un point de montage, par
exemple :

| Nom | Point de montage |
|---|---|
| `pnpm-store` | `/home/vscode/.local/share/pnpm/store` |
| `m2` | `/home/vscode/.m2` |
| `datasets` | `/data` |

## Ce que vous obtenez

- Un volume Docker nommé, `mp-proj-<projectId>-<name>`, **créé à la demande** par le premier
  worker qui en a besoin et réutilisé par tous les suivants.
- Monté dans **tous** les workers du projet, à côté de leur `/workspace` privé.
- Il **survit** à la suppression d’un worker comme à son rebuild. Il n’est détruit **qu’avec le
  projet**, après une confirmation explicite dans la boîte de dialogue de suppression.
- Visible sur la page **Resources** comme `shared`, avec son projet propriétaire, sa taille et le
  nombre d’espaces de travail qui le montent.
- La déclaration fait partie de la version du projet : restaurer une version, exporter ou importer
  un projet l’emporte avec. Seule la déclaration voyage dans un export — jamais les données.

## Points de montage refusés

`/workspace` et tout ce qui se trouve dessous sont refusés — ils masqueraient le volume propre du
worker et casseraient le clonage idempotent de l’installation. De même pour `/var/lib/docker`,
`/var/lib/containerd` et les systèmes de fichiers du noyau.

## La concurrence n’est pas gérée

> Plusieurs workers écrivent dans le même volume en même temps et **rien ne verrouille**. Cela
> convient à ce pour quoi il est fait — caches de paquets, jeux de données, fixtures, artefacts de
> build, données surtout lues. Ce n’est *pas* l’endroit pour une base SQLite partagée, un lockfile
> que deux processus réécrivent, ou quoi que ce soit qui exige un seul écrivain. Pour une base de
> données, utilisez un [service partagé](/fr/docs/shared-services).
