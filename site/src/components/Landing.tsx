import type { ReactNode } from "react"
import { CodeBlock, H2, Kicker, ProductHeader, Section, SpecList } from "@spunto/design-system/marketing"
import { SpuntoLogo } from "@spunto/design-system/brand"
import { IMAGE, lhref, REPO_URL, SPUNTO_URL, type Locale } from "../lib/i18n"

/* ─── lite.spunto.net — the home page ─────────────────────────────────────
   Same shape as the product page on spunto.net (header band, numbered
   chapters, the honest-limits table), because a visitor coming from there
   should recognise it; the difference is that this one can go further —
   agents, shared services, MCP — and hands off to the docs at every step
   instead of to a signup. Rendered once, at build time: no client JS. */

const RUN = `docker run -d --name spunto-lite -p 80:80 \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v "$HOME/.ssh:/host-ssh:ro" \\
  -v spunto-lite-ssh-agent:/run/spunto-ssh-agent \\
  -v spunto-lite-data:/app/data \\
  ${IMAGE}:latest`

const COMPOSE = `services:
  spunto-lite:
    image: ${IMAGE}:latest
    restart: unless-stopped
    ports: ["80:80"]
    environment:
      DATA_ENCRYPTION_KEY: \${DATA_ENCRYPTION_KEY}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - $HOME/.ssh:/host-ssh:ro
      - spunto-lite-ssh-agent:/run/spunto-ssh-agent
      - spunto-lite-data:/app/data

volumes:
  spunto-lite-data:
  spunto-lite-ssh-agent:`

/* The strip under each step: a command or a log line, never translated. */
const STEP_CODE = [
  `$ docker run … ${IMAGE}`,
  "→ project saved · version 1 · image building",
  "→ worker-a1b2c3.localhost · ready",
]

type Row = { label: string; lite: string | boolean; cloud: string | boolean }

const en = {
  kind: "one container, your machine",
  headline: (
    <>
      Dev environments,
      <br />
      <span className="text-signal">on your own machine.</span>
    </>
  ) as ReactNode,
  intro:
    "One container talking straight to your Docker socket. Describe a project once — base image, devcontainer features, repositories, ports, hooks, secrets — then launch disposable workspaces from it, each with VS Code in the browser and a terminal that survives a reload. Hand one to Claude Code, Codex or Mistral Vibe and review what it did. No cloud in the loop, no account, nothing phoning home.",
  chips: ["MIT", "one container", "no account", "your Docker socket", "amd64 · arm64"],
  commandNote: "then open http://localhost — no signup, no login screen",
  readDocs: "Read the docs",
  source: "Source on GitHub",
  what: { title: "What you get", note: "a control plane for throwaway environments" },
  whatH2: "Not a dotfiles script. Not a hosted IDE.",
  whatBody:
    "A small app that turns “spin me up a clean environment for this” into a button, on hardware you already pay for — and turns it back into nothing when you’re done.",
  specA: [
    ["editor", "code-server in every workspace, on its own subdomain — a full IDE in a browser tab"],
    ["terminal", "persistent: closing the tab doesn’t kill the build, and the scrollback comes back"],
    ["projects", "devcontainer-style specs: base image, features, extensions, ports, postCreate / postStart"],
    ["versions", "editing a project bumps its version and pre-builds the image, so the next launch is warm"],
  ] as [string, string][],
  specB: [
    ["your keys", "~/.ssh mounted read-only: any git host your key reaches clones and pushes, passphrase included"],
    ["secrets", "global or per project, encrypted at rest, injected as environment variables at boot"],
    ["storage", "SQLite in one volume — back it up and you’ve backed up the whole installation"],
    ["routing", "worker-<id>.localhost for the IDE, worker-<id>-<port>.localhost for every port that listens"],
  ] as [string, string][],
  how: { title: "Three minutes, start to editor", note: "run it, describe it, launch it" },
  step: "step",
  steps: [
    {
      title: "Run the container",
      body: "One docker run with the Docker socket mounted — or the compose file below. Then open http://localhost. There is no account step, because there are no accounts.",
    },
    {
      title: "Describe a project",
      body: "Start from a template (Next.js, Vite, Astro, FastAPI, Express, Docker-in-Docker) or point it at your own repository and base image. Features, ports, hooks and secrets all live in the spec.",
    },
    {
      title: "Launch a workspace",
      body: "A sibling container boots from that spec, clones your repositories, runs your hooks, and hands you an editor and a terminal on their own subdomain.",
    },
  ],
  fileKicker: "if you prefer a file",
  fileH2: "Or the compose version.",
  fileBody:
    "Same thing, easier to keep next to whatever else you already run. Set a real DATA_ENCRYPTION_KEY once (openssl rand -hex 32) — it is what your stored secrets are encrypted with.",
  installGuide: "Installation guide",
  agents: { title: "Agents", note: "delegate, then review" },
  agentsH2: "Somewhere safe to let an agent run.",
  agentsBody: [
    "A coding agent needs a shell that can install things, a server it can start and a repository it can break. Giving it that on your laptop is how you end up with a mystery daemon and a corrupted database. Giving it a Lite workspace is just a container — its own network, its own ports, its own clone — that you throw away when it’s done.",
    "Write what you want on a project, pick the harness and the model, and a worker from the project’s pool gets the session. You watch the reply as it is written, answer or interrupt it, read the diff from the machine itself, open a shell on it, then Accept or Drop.",
  ],
  agentSpec: [
    ["harnesses", "Claude Code, Codex and Mistral Vibe — their official SDKs, baked into the project’s image"],
    ["keys", "ANTHROPIC_API_KEY, OPENAI_API_KEY or MISTRAL_API_KEY, as an ordinary secret"],
    ["no git required", "no branch is cut for the task: the agent makes one if it needs one, and names it"],
    ["MCP servers", "Notion, Linear… connected once in OAuth; the worker never holds the vendor’s token"],
  ] as [string, string][],
  agentsDocs: "How tasks work",
  share: { title: "Shared on one machine", note: "the heavy things, once" },
  shareH2: "One Postgres for every project, not one per workspace.",
  shareBody:
    "Declare a long-lived dependency once under Services — presets for Postgres, MySQL, Redis, Elasticsearch, Kibana, MinIO and Mailpit — and every worker of every project reaches it by DNS at its name. A project can also mount shared volumes in all of its workers: a pnpm store, ~/.m2, a dataset.",
  shareCode: `# from any workspace
$ psql -h postgres -U postgres
$ curl http://elasticsearch:9200
$ echo $SPUNTO_SVC_POSTGRES
postgres:5432`,
  servicesDocs: "Shared services",
  limits: { title: "What Lite deliberately isn’t", note: "said here rather than found later" },
  limitsH2: "Three things it won’t do.",
  limitsBody:
    "None of these are on a roadmap. They are the line between a tool you run on your laptop and a platform a team depends on, and drawing it clearly is the only way Lite gets to stay this small.",
  wont: [
    ["No login screen.", "It holds your Docker socket, so keep it on localhost or a network you trust — never on the open internet."],
    ["One machine, one person.", "No organisations, no roles, no sharing a workspace with a teammate."],
    ["Your machine only.", "No fleet of servers, no cloud machines to rent — that’s Spunto Cloud."],
  ] as [string, string][],
  compareKicker: "lite or cloud — the whole difference",
  compare: [
    { label: "Where it runs", lite: "one machine you own", cloud: "machines you own, or Spunto Cloud" },
    { label: "Dev environments", lite: true, cloud: true },
    { label: "Agent tasks", lite: true, cloud: true },
    { label: "Install", lite: "one container", cloud: "nothing to install" },
    { label: "Cost", lite: "free — MIT", cloud: "by the minute a box runs" },
    { label: "Accounts and teams", lite: false, cloud: "orgs, members, roles" },
    { label: "Auth in front of it", lite: false, cloud: "Google sign-in, per-sandbox access" },
  ] as Row[],
  compareNote:
    "The spec you write in Lite — image, features, hooks, ports — is the format Spunto Cloud uses: export a project from one, import it in the other.",
  tryCloud: "See Spunto Cloud",
  ctaH2: "Try it in the time it takes to read this page.",
  ctaBody: "It’s MIT and the image is public, so trying it costs nothing but disk.",
}

const fr: typeof en = {
  kind: "un conteneur, votre machine",
  headline: (
    <>
      Des environnements de dev,
      <br />
      <span className="text-signal">sur votre propre machine.</span>
    </>
  ),
  intro:
    "Un conteneur qui parle directement à votre socket Docker. Décrivez un projet une fois — image de base, features devcontainer, dépôts, ports, hooks, secrets — puis lancez-en des espaces de travail jetables, chacun avec VS Code dans le navigateur et un terminal qui survit à un rechargement. Confiez-en un à Claude Code, Codex ou Mistral Vibe et relisez ce qu’il a fait. Aucun cloud dans la boucle, aucun compte, rien qui appelle la maison.",
  chips: ["MIT", "un conteneur", "aucun compte", "votre socket Docker", "amd64 · arm64"],
  commandNote: "puis ouvrez http://localhost — ni inscription, ni écran de connexion",
  readDocs: "Lire la doc",
  source: "Code source sur GitHub",
  what: { title: "Ce que vous obtenez", note: "un plan de contrôle pour environnements jetables" },
  whatH2: "Pas un script de dotfiles. Pas un IDE hébergé.",
  whatBody:
    "Une petite app qui transforme « monte-moi un environnement propre pour ça » en bouton, sur du matériel que vous payez déjà — et qui le fait disparaître quand vous avez fini.",
  specA: [
    ["éditeur", "code-server dans chaque espace de travail, sur son propre sous-domaine — un IDE complet dans un onglet"],
    ["terminal", "persistant : fermer l’onglet ne tue pas le build, et l’historique revient"],
    ["projets", "des specs à la devcontainer : image de base, features, extensions, ports, postCreate / postStart"],
    ["versions", "modifier un projet incrémente sa version et pré-construit l’image : le lancement suivant est à chaud"],
  ],
  specB: [
    ["vos clés", "~/.ssh monté en lecture seule : tout hébergeur git que votre clé atteint clone et pousse, phrase de passe comprise"],
    ["secrets", "globaux ou par projet, chiffrés au repos, injectés en variables d’environnement au démarrage"],
    ["stockage", "SQLite dans un volume — sauvegardez-le et vous avez sauvegardé toute l’installation"],
    ["routage", "worker-<id>.localhost pour l’IDE, worker-<id>-<port>.localhost pour chaque port qui écoute"],
  ],
  how: { title: "Trois minutes, du lancement à l’éditeur", note: "lancez-le, décrivez, démarrez" },
  step: "étape",
  steps: [
    {
      title: "Lancez le conteneur",
      body: "Un docker run avec le socket Docker monté — ou le fichier compose ci-dessous. Puis ouvrez http://localhost. Pas d’étape de création de compte, parce qu’il n’y a pas de comptes.",
    },
    {
      title: "Décrivez un projet",
      body: "Partez d’un modèle (Next.js, Vite, Astro, FastAPI, Express, Docker-in-Docker) ou pointez-le sur votre propre dépôt et votre image de base. Features, ports, hooks et secrets vivent tous dans la spec.",
    },
    {
      title: "Lancez un espace de travail",
      body: "Un conteneur voisin démarre à partir de cette spec, clone vos dépôts, lance vos hooks et vous donne un éditeur et un terminal sur leur propre sous-domaine.",
    },
  ],
  fileKicker: "si vous préférez un fichier",
  fileH2: "Ou la version compose.",
  fileBody:
    "La même chose, plus facile à garder à côté de ce que vous faites déjà tourner. Posez une fois une vraie DATA_ENCRYPTION_KEY (openssl rand -hex 32) : c’est avec elle que vos secrets sont chiffrés.",
  installGuide: "Guide d’installation",
  agents: { title: "Agents", note: "déléguer, puis relire" },
  agentsH2: "Un endroit sûr où laisser tourner un agent.",
  agentsBody: [
    "Un agent de code a besoin d’un shell qui peut installer des choses, d’un serveur qu’il peut démarrer et d’un dépôt qu’il peut casser. Lui donner tout ça sur votre portable, c’est finir avec un démon mystère et une base de données corrompue. Lui donner un espace de travail Lite, c’est juste un conteneur — son propre réseau, ses propres ports, son propre clone — que vous jetez quand il a fini.",
    "Écrivez ce que vous voulez sur un projet, choisissez le harnais et le modèle, et un worker du pool du projet reçoit la session. Vous suivez la réponse pendant qu’elle s’écrit, vous répondez ou l’interrompez, lisez le diff depuis la machine elle-même, ouvrez un shell dessus, puis Accept ou Drop.",
  ],
  agentSpec: [
    ["harnais", "Claude Code, Codex et Mistral Vibe — leurs SDK officiels, cuits dans l’image du projet"],
    ["clés", "ANTHROPIC_API_KEY, OPENAI_API_KEY ou MISTRAL_API_KEY, comme un secret ordinaire"],
    ["sans git imposé", "aucune branche n’est créée pour la tâche : l’agent en fait une s’il en a besoin, et la nomme"],
    ["serveurs MCP", "Notion, Linear… connectés une fois en OAuth ; le worker ne détient jamais le jeton de l’éditeur"],
  ],
  agentsDocs: "Comment marchent les tâches",
  share: { title: "Partagé sur une machine", note: "les choses lourdes, une fois" },
  shareH2: "Un Postgres pour tous les projets, pas un par espace de travail.",
  shareBody:
    "Déclarez une dépendance au long cours une fois dans Services — modèles pour Postgres, MySQL, Redis, Elasticsearch, Kibana, MinIO et Mailpit — et chaque worker de chaque projet l’atteint par DNS, à son nom. Un projet peut aussi monter des volumes partagés dans tous ses workers : un store pnpm, ~/.m2, un jeu de données.",
  shareCode: en.shareCode,
  servicesDocs: "Services partagés",
  limits: { title: "Ce que Lite n’est pas, exprès", note: "dit ici plutôt que découvert plus tard" },
  limitsH2: "Trois choses qu’il ne fera pas.",
  limitsBody:
    "Aucune n’est sur une feuille de route. C’est la frontière entre un outil qu’on fait tourner sur son portable et une plateforme dont dépend une équipe, et la tracer nettement est la seule façon pour Lite de rester aussi petit.",
  wont: [
    ["Pas d’écran de connexion.", "Il détient votre socket Docker : gardez-le sur localhost ou sur un réseau de confiance — jamais sur Internet."],
    ["Une machine, une personne.", "Pas d’organisations, pas de rôles, pas d’espace partagé avec un collègue."],
    ["Votre machine seulement.", "Pas de parc de serveurs, pas de machines cloud à louer — c’est Spunto Cloud."],
  ],
  compareKicker: "lite ou cloud — toute la différence",
  compare: [
    { label: "Où il tourne", lite: "une machine à vous", cloud: "vos machines, ou Spunto Cloud" },
    { label: "Environnements de dev", lite: true, cloud: true },
    { label: "Tâches d’agent", lite: true, cloud: true },
    { label: "Installation", lite: "un conteneur", cloud: "rien à installer" },
    { label: "Coût", lite: "gratuit — MIT", cloud: "à la minute où une boîte tourne" },
    { label: "Comptes et équipes", lite: false, cloud: "organisations, membres, rôles" },
    { label: "Authentification devant", lite: false, cloud: "connexion Google, accès par sandbox" },
  ],
  compareNote:
    "La spec que vous écrivez dans Lite — image, features, hooks, ports — est le format de Spunto Cloud : exportez un projet de l’un, importez-le dans l’autre.",
  tryCloud: "Voir Spunto Cloud",
  ctaH2: "Essayez-le le temps de lire cette page.",
  ctaBody: "C’est sous licence MIT et l’image est publique : essayer ne coûte que de l’espace disque.",
}

const COPY = { en, fr }

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  )
}

function Cell({ value, accent }: { value: string | boolean; accent?: boolean }) {
  if (value === true)
    return (
      <span className="text-emerald-500" aria-label="yes">
        ✓
      </span>
    )
  if (value === false)
    return (
      <span className="text-muted-foreground/40" aria-label="no">
        —
      </span>
    )
  return <span className={`text-sm ${accent ? "text-foreground" : "text-muted-foreground"}`}>{value}</span>
}

const primaryBtn =
  "inline-flex items-center gap-2 rounded-md bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
const ghostBtn =
  "inline-flex items-center gap-2 rounded-md border border-border bg-card px-5 py-2.5 text-sm font-medium transition-colors hover:border-primary/40"
const textLink = "text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"

export function Landing({ locale }: { locale: Locale }) {
  const t = COPY[locale]
  const docs = (path: string) => lhref(locale, `/docs${path}`)
  const cloudHref = locale === "fr" ? `${SPUNTO_URL}/fr` : SPUNTO_URL

  return (
    <>
      <ProductHeader
        mark={<SpuntoLogo tone="product" size={34} />}
        name="Spunto Lite"
        kind={t.kind}
        headline={t.headline}
        intro={t.intro}
        chips={t.chips}
        accent="var(--signal)"
        command={RUN}
        commandNote={t.commandNote}
        actions={
          <>
            <a href={docs("/installation")} className={primaryBtn}>
              {t.readDocs} →
            </a>
            <a
              href={REPO_URL}
              className="inline-flex items-center gap-2 rounded-md border border-white/15 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:border-white/40"
            >
              <GithubMark className="h-4 w-4 shrink-0" />
              {t.source}
            </a>
          </>
        }
      />

      <main className="mx-auto max-w-6xl border-x border-border">
        {/* ── 01 · What you get ──────────────────────────────────────── */}
        <Section id="what" n="01" title={t.what.title} note={t.what.note}>
          <div className="mb-10 grid gap-6 md:mb-14 md:grid-cols-12 md:gap-10">
            <div className="md:col-span-7">
              <H2>{t.whatH2}</H2>
            </div>
            <p className="leading-relaxed text-muted-foreground md:col-span-5 md:pt-1">{t.whatBody}</p>
          </div>
          <div className="grid gap-6 md:grid-cols-2 md:gap-10">
            <SpecList rows={t.specA} />
            <SpecList rows={t.specB} />
          </div>
        </Section>

        {/* ── 02 · Three steps ───────────────────────────────────────── */}
        <Section id="how" n="02" title={t.how.title} note={t.how.note}>
          {/* `[&>*]:min-w-0`: each step ends on a `whitespace-nowrap` strip,
              which would otherwise set the column's min-content and push the
              cards off a phone. The strip scrolls on its own instead. */}
          <div className="grid overflow-hidden rounded-lg border border-border md:grid-cols-3 md:divide-x md:divide-border [&>*]:min-w-0">
            {t.steps.map((s, i) => (
              <div key={i} className="flex flex-col border-b border-border bg-card/50 last:border-b-0 md:border-b-0">
                <div className="flex-1 p-5 md:p-6">
                  <p className="font-mono text-[11px] text-primary">
                    {t.step} {i + 1}
                  </p>
                  <h3 className="font-display mt-2 text-lg font-bold tracking-[-0.02em]">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                </div>
                <div
                  translate="no"
                  className="bg-code-surface overflow-x-auto whitespace-nowrap px-5 py-3 font-mono text-[11px] text-stone-300 md:px-6"
                >
                  {STEP_CODE[i]}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-12 grid gap-10 lg:grid-cols-2 lg:gap-14 [&>*]:min-w-0">
            <div>
              <Kicker>{t.fileKicker}</Kicker>
              <H2 className="mt-3">{t.fileH2}</H2>
              <p className="mt-4 max-w-[52ch] leading-relaxed text-muted-foreground">{t.fileBody}</p>
              <div className="mt-7 flex flex-wrap items-center gap-4">
                <a href={docs("/installation")} className={ghostBtn}>
                  {t.installGuide} →
                </a>
                <a href={REPO_URL} className={textLink}>
                  {t.source}
                </a>
              </div>
            </div>
            <CodeBlock code={COMPOSE} filename="docker-compose.yml" className="self-start" />
          </div>
        </Section>

        {/* ── 03 · Agents ────────────────────────────────────────────── */}
        <Section id="agents" n="03" title={t.agents.title} note={t.agents.note}>
          <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
            <div>
              <H2>{t.agentsH2}</H2>
              {t.agentsBody.map((p, i) => (
                <p key={i} className="mt-4 max-w-[56ch] leading-relaxed text-muted-foreground">
                  {p}
                </p>
              ))}
              <a href={docs("/agents")} className={`${ghostBtn} mt-7`}>
                {t.agentsDocs} →
              </a>
            </div>
            <SpecList rows={t.agentSpec} className="self-start" />
          </div>
        </Section>

        {/* ── 04 · Shared services & volumes ─────────────────────────── */}
        <Section id="shared" n="04" title={t.share.title} note={t.share.note}>
          <div className="grid gap-10 lg:grid-cols-2 lg:gap-14 [&>*]:min-w-0">
            <div>
              <H2>{t.shareH2}</H2>
              <p className="mt-4 max-w-[54ch] leading-relaxed text-muted-foreground">{t.shareBody}</p>
              <div className="mt-7 flex flex-wrap items-center gap-4">
                <a href={docs("/shared-services")} className={ghostBtn}>
                  {t.servicesDocs} →
                </a>
              </div>
            </div>
            <CodeBlock code={t.shareCode} filename="worker-a1b2c3 — bash" className="self-start" />
          </div>
        </Section>

        {/* ── 05 · The honest limits ─────────────────────────────────── */}
        <Section id="limits" n="05" title={t.limits.title} note={t.limits.note}>
          <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
            <div>
              <H2>{t.limitsH2}</H2>
              <p className="mt-4 max-w-[54ch] leading-relaxed text-muted-foreground">{t.limitsBody}</p>
              <ul className="mt-8 space-y-4">
                {t.wont.map(([lead, rest]) => (
                  <li key={lead} className="flex gap-3 border-b border-border pb-4">
                    <span className="mt-[3px] shrink-0 font-mono text-amber-500">!</span>
                    <span className="text-sm leading-relaxed text-muted-foreground">
                      <span className="font-medium text-foreground/90">{lead}</span> {rest}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="self-start">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{t.compareKicker}</p>
              <div className="mt-4 overflow-hidden rounded-lg border border-border">
                <div className="grid grid-cols-[1.15fr_1fr_1fr] gap-3 border-b border-border bg-card px-4 py-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  <span />
                  <span className="text-primary">Lite</span>
                  <span className="text-primary">Cloud</span>
                </div>
                {t.compare.map((row) => (
                  <div
                    key={row.label}
                    className="grid grid-cols-[1.15fr_1fr_1fr] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                  >
                    <span className="text-sm text-foreground/85">{row.label}</span>
                    <Cell value={row.lite} />
                    <Cell value={row.cloud} accent />
                  </div>
                ))}
              </div>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{t.compareNote}</p>
              <a href={cloudHref} className={`${textLink} mt-3 inline-block`}>
                {t.tryCloud} →
              </a>
            </div>
          </div>
        </Section>

        {/* ── Closing ─────────────────────────────────────────────────── */}
        <div className="px-5 py-16 md:px-10 md:py-24">
          <div className="flex flex-col items-start gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <H2>{t.ctaH2}</H2>
              <p className="mt-3 max-w-[52ch] leading-relaxed text-muted-foreground">{t.ctaBody}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <a href={docs("/installation")} className={primaryBtn}>
                {t.readDocs} →
              </a>
              <a href={REPO_URL} className={ghostBtn}>
                <GithubMark className="h-4 w-4 shrink-0" />
                GitHub
              </a>
            </div>
          </div>
        </div>
      </main>
    </>
  )
}
