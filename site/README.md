# lite.spunto.net

Spunto Lite's own website: the product page and the user documentation, in English and French.
A static [Astro](https://astro.build) site drawn with `@spunto/design-system` (its `/marketing`
and `/brand` entries), published on GitHub Pages by `.github/workflows/site.yml` on every merge
to `main` that touches `site/`.

```bash
cd site
npm install
npm run dev      # http://localhost:4321
npm run build    # → dist/
```

## Where things are

| What | Where |
|---|---|
| Home page (en + fr copy) | `src/components/Landing.tsx` |
| Docs pages | `src/content/docs/en/*.md`, `src/content/docs/fr/*.md` — same file name in both |
| Docs sidebar | each page's frontmatter: `group` (`start`, `use`, `agents`, `operate`) and `order` |
| Nav, footer, UI strings | `src/components/`, `src/lib/i18n.ts` |
| Prose styles | `src/styles/global.css` |

## Writing docs

- The docs are for **people running Lite**, not for its contributors: the internal design notes
  stay in `../docs/` (in French). A doc page states what the product does today; when behaviour
  changes in a PR, the page that describes it changes in the same PR.
- Every page exists in both languages. English links are `/docs/<slug>`, French ones
  `/fr/docs/<slug>`.
- Dashboard labels stay in English in both languages (`**Settings → SSH keys**`): that is what the
  reader sees on screen.
