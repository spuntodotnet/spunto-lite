-- BAC-77: Docker inside a worker is the docker-in-docker feature, whose metadata asks for a
-- privileged container (lib/feature-metadata.ts). A project that had the switch on without the
-- feature gets the feature in its place — as `resolveFeatures` (services/projects.ts) would store it.
-- No new version: the image already built keeps serving, and the feature makes its workers privileged.
UPDATE `projects`
SET `features` = json_insert(`features`, '$[#]', json('{"id":"docker-in-docker","options":{"moby":"false"},"ociRef":"ghcr.io/coderhammer/features/docker-in-docker:3"}'))
WHERE `dind` = 1
  AND NOT EXISTS (SELECT 1 FROM json_each(`projects`.`features`) WHERE json_extract(value, '$.id') = 'docker-in-docker');
--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `dind`;
