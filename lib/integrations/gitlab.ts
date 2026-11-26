import type { IntegrationDefinition } from "./types"

/** GitLab.com and every self-hosted instance: `/<group/…/project>/-/merge_requests/<iid>`. */
const MR_PATH = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#]|$)/

export const gitlab: IntegrationDefinition = {
  kind: "gitlab",
  label: "GitLab",
  defaultHost: "gitlab.com",
  shortLabel: "MR",
  numberMark: "!",
  parsePullRequestPath(pathname) {
    const m = MR_PATH.exec(pathname)
    return m ? { repo: m[1], number: Number(m[2]) } : null
  },
  pullRequestPath: (repo, number) => `/${repo}/-/merge_requests/${number}`,
  newTokenUrl: (origin) =>
    `${origin}/-/user_settings/personal_access_tokens?name=Spunto+Lite&scopes=read_api,read_repository,write_repository`,
  tokenScopes: "read_api, plus read_repository and write_repository to clone and push",
  tokenEnvVar: "GITLAB_TOKEN",
  gitUsername: "oauth2",
}
