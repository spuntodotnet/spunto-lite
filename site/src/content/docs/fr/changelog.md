---
title: "Nouveautés"
description: "Ce qui change dans Spunto Lite, semaine après semaine : ce que vous pouvez faire, voir, ou ne plus subir."
group: operate
order: 4
---

Ce qui change dans Lite, du plus récent au plus ancien. Tout ce qui est listé ici est dans l’image
`latest` à partir du jour indiqué : pour l’avoir, [mettez Lite à jour](/fr/docs/installation#mettre-à-jour),
mêmes volumes, même clé, rien à migrer à la main.

## 2026-11-21

**On hold, des tags de projet, et Lite sans l’IDE**

### Nouveau

- **On hold.** Une revue qui peut attendre passe **On hold**, depuis l’en-tête de la tâche ou sa
  ligne : sa machine est garée, et la tâche quitte la liste par défaut pour la vue **On hold**,
  avec son compte. Répondre, **Wake**, Accept ou Drop la ramènent ; **Back to review** la remet
  en revue sans réveiller la machine. [Détails](/fr/docs/agents#on-hold-pour-plus-tard)
- **Tags de projet.** Ajoutez des tags à côté du nom d’un projet ; la table Projects les affiche
  sous chaque nom, filtre dessus (tous les tags choisis doivent y être), et la recherche les lit.
  Poser un tag ne crée pas de version et ne reconstruit rien. Par l’API :
  `PUT /api/projects/:id/tags`. [Détails](/fr/docs/projects#tags)
- **Un projet sans Spunto IDE.** Coupez **Spunto IDE** sous les extensions du projet : son image
  est construite sans l’éditeur, **Open IDE** disparaît partout, et le terminal reste. Ça fait
  partie de l’image : le changer crée une nouvelle version. [Détails](/fr/docs/workers#lide)

### Amélioré

- **Ouvrir un port d’un worker arrêté** affiche maintenant **Workspace is stopped** avec un bouton
  **Start workspace**, puis recharge la page demandée une fois le worker prêt, au lieu de « Not
  reachable ». Des pages disent aussi qu’un workspace démarre encore, que rien n’écoute sur le
  port (avec **Retry**), ou que le workspace n’existe pas.

### Corrigé

- **Usage ne gèle plus Lite.** Sur un long historique, ouvrir **Usage** bloquait tout le dashboard
  pendant plusieurs secondes. Le rapport se calcule maintenant en arrière-plan : la page affiche
  *Computing usage…*, vous pouvez la quitter, et tout le reste continue de répondre.

## 2026-11-12

**Une page pour ce qu’ont consommé vos agents, et des tâches en échec qui reprennent**

### Nouveau

- **Usage** dans la barre latérale : coût, tours, contexte envoyé (et la part lue en cache), tokens
  générés et appels d’outils, sur 1, 7, 30 ou 90 jours ou depuis le début ; par jour, par tâche
  (chaque ligne mène à sa conversation), par projet, agent et modèle, et par outil avec ses
  erreurs. Les agents qui ne rapportent aucun coût (Codex) affichent leurs tokens, et « — » plutôt
  qu’un prix deviné.
- **Claude Fable 5.2** dans les modèles de Claude Code. Il remplace Fable 5.1 : un projet dont le
  modèle par défaut est Fable 5.1 doit en choisir un autre pour être enregistré ; les tâches déjà
  créées gardent le leur.
- **Télémétrie au choix**, coupée par défaut et sans destination par défaut : faites pointer
  `TELEMETRY_OTLP_ENDPOINT` vers votre propre collecteur OTLP pour recevoir les démarrages, les
  battements, les pages vues et les actions — jamais de noms, de query strings, de corps de
  requête ni d’IP. [Détails](/fr/docs/security#télémétrie)

### Amélioré

- **Répondez à une tâche en échec** et elle reprend, de nouveau en revue, avec sa conversation —
  même si son worker est passé depuis à une autre tâche (les deux le partagent). Quand ce n’est pas
  possible (worker supprimé, setup en échec, aucune session), la tâche dit pourquoi.
- **Docker dans l’espace de travail vient de la feature.** Plus d’interrupteur Docker-in-Docker :
  lister la feature `docker-in-docker` donne à l’espace de travail ce qu’il lui faut, comme le
  prévoit le spec devcontainer. Les projets qui avaient l’interrupteur allumé ont reçu la feature à
  la mise à jour, sans nouvelle version ni reconstruction.
  [Détails](/fr/docs/projects#docker-dans-lespace-de-travail)

### Corrigé

- **Arrêtez puis démarrez un worker** et son `postStartCommand` rejoue ; il était sauté.
- **Resources se charge en un instant**, même avec de gros volumes Docker : les listes sont en
  direct, le CPU et la mémoire rafraîchis toutes les 15 s, et la taille des volumes toutes les
  10 minutes ou sur **Measure now**, gardée après un redémarrage.

## 2026-11-07

**Tout ce que Spunto Cloud a livré début novembre, en local**

### Nouveau

- **Mistral Vibe**, un troisième agent à côté de Claude Code et de Codex (`MISTRAL_API_KEY`).
- **Le message de l’agent s’affiche pendant qu’il l’écrit.**
- **Des tâches sans git.** Lite ne crée plus de branche, et une tâche n’a plus besoin de dépôt :
  l’agent fait une branche s’il en veut une. [Détails](/fr/docs/agents#aucun-git-imposé)
- **Dans les détails d’une tâche** : un bloc **Monitoring** (CPU et mémoire en direct, historique
  d’une heure à 7 jours), les liens et fichiers de la conversation avec les pull requests parmi
  eux, la session Claude Code (quota, serveurs MCP, skills, coût par modèle), et les liens et
  métadonnées posés par qui l’a déléguée (`?metadata[k]=v` pour filtrer les tâches).
- **Ports nommés** (un libellé et un chemin) dans le formulaire du projet, en vert dans le panneau
  Machine quand ils écoutent.
- **La couleur du dashboard** dans **Settings → Appearance**.
  [Détails](/fr/docs/configuration#dans-le-tableau-de-bord)

### Amélioré

- **Projects** devient un tableau triable, favoris en tête, avec une recherche et des raccourcis
  vers un workspace ou une tâche.
- **Park after N minutes** et **Keep awake** pendant une revue ; le compte à rebours tient après un
  redémarrage de Lite. [Détails](/fr/docs/agents#pendant-la-revue-garder-ou-garer)
