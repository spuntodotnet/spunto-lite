---
title: "Connecter à Spunto"
description: "Retrouver les tâches d’agent de votre Lite sur votre téléphone — l’app iPhone Spunto Lite — par votre compte Spunto, sans ouvrir de port."
group: agents
order: 3
---

Lite tourne sur votre machine, derrière votre box, sans écran de connexion. **Connect to Spunto**
rend ses tâches d’agent joignables depuis les appareils où vous êtes connecté à
[Spunto](https://spunto.net) — d’abord l’app iPhone **Spunto Lite** — sans ouvrir de port ni
exposer Lite :

- Lite ouvre un tunnel **vers** Spunto (sortant, comme un onglet de navigateur) ;
- Spunto lui relaie une courte liste de requêtes de tâches venues de vos appareils, et ne garde
  rien de ce qui passe ;
- Lite revérifie chaque requête, et ne répond qu’à ce que vous avez permis.

C’est **coupé tant que vous ne le connectez pas**.

## Se connecter

1. **Settings → Connect to Spunto.** Donnez si vous voulez un nom à la machine (celui que votre
   téléphone affichera) ; l’URL de Spunto reste `https://spunto.net`.
2. Cochez **ce que vos appareils peuvent faire** (ci-dessous). Seul *Read* est coché au départ.
3. **Connect to Spunto** : vous arrivez sur la page de consentement de Spunto (connectez-vous si
   besoin), qui présente l’application comme une *Spunto Lite*. **Allow** vous ramène dans
   Settings, connecté.

L’état affiche alors **Online**, avec l’identifiant de la connexion. Si le tunnel tombe (Wi-Fi, mise
à jour de Spunto), Lite se reconnecte seul, en attendant un peu plus à chaque fois, jusqu’à 30
secondes.

Ouvrez Lite sur `http://localhost` (le défaut) ou en `https://` pour vous connecter : Spunto ne
renvoie que vers une adresse sûre, et le `http://` simple n’est accepté que sur `localhost`.

## Ce que vos appareils peuvent faire

| | Ce que ça permet |
|---|---|
| **Read** | lister projets et tâches, lire une conversation, son diff et ses pièces jointes |
| **Reply** | répondre à une tâche, l’interrompre, l’accepter (Accept) ou l’abandonner (Drop) |
| **Create tasks** | déléguer une nouvelle tâche à un projet |

**Create tasks** démarre un agent sur cette machine, depuis votre téléphone, avec votre clé SSH et
vos secrets : ne le cochez que si c’est bien ce que vous voulez.

Un changement vaut tout de suite : le tunnel se reconnecte avec la nouvelle liste. Quoi qu’il soit
coché, **les secrets, les réglages (où est votre clé SSH), les workers, les terminaux et les
services ne sont jamais joignables** par ce chemin.

## Notifications

Quand une tâche rend la main (**In review**) ou **échoue**, Lite le dit à Spunto — le titre de la
tâche et les premiers mots du dernier message de l’agent — pour que votre téléphone vous prévienne.
Rien n’est envoyé quand Lite est hors ligne, ni quand vous abandonnez vous-même une tâche.

## Se déconnecter

- **Disconnect** dans Settings oublie les jetons et ferme le tunnel. Spunto continue de lister la
  machine, hors ligne, jusqu’à ce que vous l’y retiriez.
- La retirer dans Spunto (**Account Settings → Connected apps**) ferme le tunnel aussitôt ; Lite
  affiche alors *Disconnected* et ne réessaie plus avant une nouvelle connexion.
- Si Spunto n’accepte plus les identifiants de Lite (30 jours sans usage, par exemple), Lite
  affiche *Disconnected* avec la raison : reconnectez-le.

Les jetons de Lite sont rangés chiffrés dans sa base, jamais dans ses journaux. Le détail technique
— le protocole du tunnel, les routes relayées — est dans
[`docs/lite-connect.md`](https://github.com/spuntodotnet/spunto-lite/blob/main/docs/lite-connect.md)
du dépôt.
