---
title: "Secrets"
description: "Les secrets globaux et propres à un projet, leur chiffrement, et la façon dont ils atteignent un espace de travail."
group: use
order: 4
---

Un secret est un nom et une valeur — une clé d’API, un mot de passe de base de données, un jeton —
qui arrive dans un espace de travail sous forme de **variable d’environnement**. Les valeurs sont
en écriture seule : une fois enregistré, le tableau de bord affiche le nom, plus jamais la valeur.

## Deux portées

| Portée | Où | Atteint |
|---|---|---|
| **Globale** | **Secrets** dans la barre latérale | tous les workers de tous les projets |
| **Projet** | la page **Secrets** du formulaire du projet | les workers de ce projet |

Quand les deux définissent le même nom, **celui du projet l’emporte**. Ajouter un secret sous un
nom existant remplace sa valeur.

## Quand ils sont lus

Les secrets sont injectés à la **création** du conteneur d’un worker. Un secret ajouté ou modifié
plus tard atteint un worker existant après un **Rebuild** (son `/workspace` est conservé), et tout
nouveau worker immédiatement. Ils sont dans l’environnement de tout ce qui tourne dans le worker :
les hooks de cycle de vie, les terminaux, l’IDE, la session d’un agent.

## Chiffrement

Les valeurs sont chiffrées au repos en **AES-256-GCM**, avec la clé de `DATA_ENCRYPTION_KEY` :

```bash
openssl rand -hex 32
```

Définissez-la avant d’enregistrer quoi que ce soit, et conservez-la : recréer le conteneur avec une
autre clé rend les secrets enregistrés illisibles. Sans elle, Lite utilise une clé de
développement intégrée — suffisante pour un essai, pas pour de vrais identifiants.

## Secrets des services partagés

Une variable d’environnement d’un [service partagé](/fr/docs/shared-services) est soit une valeur
littérale, soit une **référence à un secret global** par son nom — déchiffré uniquement à la
création du conteneur du service. Mettez un vrai mot de passe dans un secret global et
référencez-le, plutôt que de le saisir dans le service. Une référence à un secret qui n’existe plus
est ignorée avec un avertissement, au lieu d’être injectée vide.

## Secrets et agents

Un agent de code lit la clé de son fournisseur dans un secret ordinaire — `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` (ou `CODEX_API_KEY`), `MISTRAL_API_KEY` — global ou propre au projet. Voir
[Agents](/fr/docs/agents).

## Dans un export

[Exporter un projet](/fr/docs/projects#export-et-import) n’emporte que les **noms** de ses secrets.
L’import prépare les lignes pour que vous puissiez saisir de nouveau les valeurs.
