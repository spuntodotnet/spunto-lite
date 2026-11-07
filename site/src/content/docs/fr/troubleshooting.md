---
title: "Dépannage"
description: "Les suspects habituels — des URL qui ne se résolvent pas, un port déjà pris, un clonage qui échoue, un worker bloqué en starting."
group: operate
order: 3
---

Commencez par les logs de Lite lui-même, et par la page du worker — ses étapes **Setup** indiquent
où un worker s’est arrêté :

```bash
docker logs -f spunto-lite
```

## `http://localhost` ne répond pas

- Le conteneur tourne-t-il ? `docker ps --filter name=spunto-lite`.
- Le port 80 est-il pris par autre chose (un autre serveur web, le récepteur AirPlay sur certaines
  versions de macOS) ? Lancez Lite sur un autre port avec `-p 8080:8080 -e PORT=8080`.

## `worker-….localhost` ne se résout pas

`*.localhost` est résolu par le navigateur lui-même dans Chrome, Edge et Firefox. Safari, `curl` et
certains outils ne le font pas toujours : utilisez l’un de ces navigateurs, ou ajoutez le nom à
`/etc/hosts`. *Depuis l’intérieur* d’un conteneur, `localhost` désigne le conteneur lui-même — voir
[Configuration](/fr/docs/configuration#https-et-un-autre-domaine).

## Le clonage échoue : `Permission denied (publickey)`

- **Settings → SSH keys** : la clé attendue est-elle sélectionnée, et sa partie publique est-elle
  chez l’hébergeur git ?
- Porte-t-elle un badge *passphrase* ? Déverrouillez-la dans Settings, ou relayez l’agent de votre
  hôte ([Clés SSH et git](/fr/docs/ssh-and-git)).
- Le volume `spunto-lite-ssh-agent` est-il monté sur le conteneur Lite ? Settings le signale si ce
  n’est pas le cas.
- Depuis le terminal du worker : `ssh -T git@github.com` (ou votre hébergeur) montre ce que voit le
  serveur.

## Un worker est bloqué en `starting`, ou en `error`

- La page du worker affiche les étapes de l’installation et celle qui a échoué : une feature qui ne
  s’est pas installée, un hook sorti avec un code non nul, un clonage refusé.
- Un `postCreateCommand` qui ne se termine jamais (un serveur de développement lancé là plutôt que
  dans `postStartCommand`) maintient le worker en `starting` : déplacez les processus de longue
  durée dans `postStartCommand`, en arrière-plan.
- `error` avec un code de sortie après être passé par `ready` : le conteneur est mort de lui-même —
  souvent faute de mémoire. Consultez les logs du worker et **Resources**.
- Après une mise à jour, un worker créé par une version beaucoup plus ancienne de Lite peut avoir
  besoin d’un **Rebuild** pour recevoir l’agent embarqué actuel et le volume de l’agent SSH.

## Le build de l’image échoue

Ouvrez le journal du build depuis la page du projet. Causes habituelles : une image de base
impossible à récupérer (registre privé — voir
[Configuration](/fr/docs/configuration#images-de-base-privées)), une feature dont les options ne
conviennent pas à l’image de base (par exemple une feature qui attend Debian sur une image Alpine),
ou pas de réseau.

## Un secret, ou une variable de service, n’est pas dans l’environnement

Les deux sont définis à la création d’un worker. Faites un **Rebuild** du worker — `/workspace` est
conservé.

## Le disque se remplit

**Resources** liste chaque conteneur, image et volume que possède Lite, avec sa taille. Supprimez
les espaces de travail dont vous ne vous servez pas ; les anciennes images d’un projet partent avec
lui. `docker system df` montre le reste de l’occupation de l’hôte.

## Toujours bloqué ?

Ouvrez une issue sur [GitHub](https://github.com/spuntodotnet/spunto-lite/issues) avec les logs de
Lite et les étapes d’installation du worker.
