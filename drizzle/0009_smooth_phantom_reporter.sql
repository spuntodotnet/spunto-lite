ALTER TABLE `projects` DROP COLUMN `deploy_key_private`;--> statement-breakpoint
-- Un dépôt n'a plus d'« hébergeur » : c'est une URL de clone, tirée avec la clé SSH montée.
-- Les lignes écrites avant portaient un `provider` et un libellé `owner/repo` à la place de
-- l'URL, et l'adresse qu'il fallait en déduire était connue du code. Elle est archivée ici, à
-- l'endroit qui documente ce que les anciennes données voulaient dire, plutôt que gardée en
-- mémoire par le produit : après cette migration, plus rien à l'exécution ne sait qu'un
-- `provider` a existé.
--
-- Une valeur inconnue donne `cloneUrl: null` — la ligne réapparaît dans le formulaire comme un
-- dépôt à compléter, ce qui est préférable à une URL devinée sur un hôte qu'on n'a jamais su.
UPDATE projects SET repositories = (
  SELECT json_group_array(
    json_set(
      json_set(r.value, '$.provider', 'git'),
      '$.cloneUrl',
      COALESCE(
        json_extract(r.value, '$.cloneUrl'),
        CASE json_extract(r.value, '$.provider')
          WHEN 'github'    THEN 'git@github.com:'    || json_extract(r.value, '$.project') || '.git'
          WHEN 'gitlab'    THEN 'git@gitlab.com:'    || json_extract(r.value, '$.project') || '.git'
          WHEN 'bitbucket' THEN 'git@bitbucket.org:' || json_extract(r.value, '$.project') || '.git'
        END
      )
    )
  )
  FROM json_each(projects.repositories) AS r
)
WHERE EXISTS (
  SELECT 1 FROM json_each(projects.repositories) AS r2
  WHERE json_extract(r2.value, '$.provider') <> 'git'
);--> statement-breakpoint
-- Les snapshots de version portent la même forme : restaurer une version d'avant ne doit pas
-- réintroduire un dépôt que le produit ne sait plus cloner.
UPDATE project_versions SET config = json_set(config, '$.repositories', (
  SELECT json_group_array(
    json_set(
      json_set(r.value, '$.provider', 'git'),
      '$.cloneUrl',
      COALESCE(
        json_extract(r.value, '$.cloneUrl'),
        CASE json_extract(r.value, '$.provider')
          WHEN 'github'    THEN 'git@github.com:'    || json_extract(r.value, '$.project') || '.git'
          WHEN 'gitlab'    THEN 'git@gitlab.com:'    || json_extract(r.value, '$.project') || '.git'
          WHEN 'bitbucket' THEN 'git@bitbucket.org:' || json_extract(r.value, '$.project') || '.git'
        END
      )
    )
  )
  FROM json_each(json_extract(project_versions.config, '$.repositories')) AS r
))
WHERE EXISTS (
  SELECT 1 FROM json_each(json_extract(project_versions.config, '$.repositories')) AS r2
  WHERE json_extract(r2.value, '$.provider') <> 'git'
);
