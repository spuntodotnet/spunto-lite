export type Locale = "en" | "fr"

export const REPO_URL = "https://github.com/spuntodotnet/spunto-lite"
export const IMAGE = "ghcr.io/spuntodotnet/spunto-lite"
export const SPUNTO_URL = "https://spunto.net"

/** A path of this site in a language: English has no prefix, French lives under /fr. */
export function lhref(locale: Locale, path: string): string {
  if (locale === "en") return path
  return path === "/" ? "/fr" : `/fr${path}`
}

/** The same page in the other language. */
export function switchLocale(path: string, to: Locale): string {
  const bare = path.replace(/^\/fr(?=\/|$)/, "") || "/"
  return lhref(to, bare)
}

export const UI = {
  en: {
    docs: "Docs",
    github: "GitHub",
    home: "Home",
    getStarted: "Get started",
    onThisPage: "On this page",
    edit: "Edit this page on GitHub",
    previous: "Previous",
    next: "Next",
    menu: "Menu",
    theme: "Toggle theme",
    languageName: "Français",
    footerTagline: "The environment half of Spunto, in one container on your machine.",
    footerBy: "A Spunto product",
    license: "MIT license",
    builtOn: "UI built on",
    groups: {
      start: "Getting started",
      use: "Using Lite",
      agents: "Agents",
      operate: "Running it",
    },
  },
  fr: {
    docs: "Docs",
    github: "GitHub",
    home: "Accueil",
    getStarted: "Commencer",
    onThisPage: "Sur cette page",
    edit: "Modifier cette page sur GitHub",
    previous: "Précédent",
    next: "Suivant",
    menu: "Menu",
    theme: "Changer de thème",
    languageName: "English",
    footerTagline: "La moitié « environnements » de Spunto, dans un conteneur sur votre machine.",
    footerBy: "Un produit Spunto",
    license: "Licence MIT",
    builtOn: "Interface bâtie sur",
    groups: {
      start: "Premiers pas",
      use: "Utiliser Lite",
      agents: "Agents",
      operate: "L’exploiter",
    },
  },
} satisfies Record<Locale, unknown>
