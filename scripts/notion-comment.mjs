#!/usr/bin/env node
// Poste un commentaire Notion **en format riche** (gras, italique, liens
// cliquables) sur une page/carte, à partir d'un petit markup lisible.
//
// L'API Notion `POST /v1/comments` prend un tableau `rich_text[]` de segments
// typés : le gras/l'italique passent par `annotations`, un lien par
// `text.link.url` (objet). Ce helper convertit un markup minimal
// (`**gras**`, `*italique*`, `[texte](url)`, sauts de ligne) vers ce format,
// pour ne pas le ré-encoder à la main à chaque handoff.
//
// Markup supporté :
//   **gras**            → { annotations: { bold: true } }
//   *italique*          → { annotations: { italic: true } }
//   [texte](https://…)  → { text: { content, link: { url } } }
//   sauts de ligne      → segments "\n"
//   emoji               → passent tels quels
//
// Usage :
//   node scripts/notion-comment.mjs <pageId> --file message.txt
//   node scripts/notion-comment.mjs <pageId> < message.txt          # via stdin
//   NOTION_TOKEN=… node scripts/notion-comment.mjs <pageId> --dry-run < message.txt
//
// Requiert NOTION_TOKEN dans l'environnement (token d'intégration, déjà injecté
// dans tout worker via les secrets), sauf en --dry-run qui imprime le JSON.

import { readFile } from "node:fs/promises";

const NOTION_VERSION = process.env.NOTION_VERSION || "2022-06-28";

// Un seul passage de tokenisation : lien | gras | italique. Le gras (`**`) est
// testé avant l'italique (`*`) pour ne pas le fragmenter.
const TOKEN = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

function segmentsForLine(line) {
  const segments = [];
  let lastIndex = 0;
  let match;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: { content: line.slice(lastIndex, match.index) } });
    }
    const [, linkText, linkUrl, boldText, italicText] = match;
    if (linkUrl !== undefined) {
      // Lien Notion : URL en objet `link: { url }` (à la différence du format
      // Quill/Delta de ClickUp où c'était une chaîne).
      segments.push({ type: "text", text: { content: linkText, link: { url: linkUrl } } });
    } else if (boldText !== undefined) {
      segments.push({ type: "text", text: { content: boldText }, annotations: { bold: true } });
    } else {
      segments.push({ type: "text", text: { content: italicText }, annotations: { italic: true } });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < line.length) {
    segments.push({ type: "text", text: { content: line.slice(lastIndex) } });
  }
  return segments;
}

// Construit le tableau `rich_text[]` à partir d'un texte structuré multi-lignes.
// Exporté pour réutilisation (tests, autre outillage) sans passer par le CLI.
export function buildRichText(markup) {
  const lines = markup.replace(/\r\n/g, "\n").split("\n");
  const richText = [];
  lines.forEach((line, i) => {
    if (line.length > 0) richText.push(...segmentsForLine(line));
    if (i < lines.length - 1) richText.push({ type: "text", text: { content: "\n" } });
  });
  // Notion refuse un rich_text vide : garantir au moins un segment.
  return richText.length > 0 ? richText : [{ type: "text", text: { content: markup } }];
}

export async function postComment(pageId, markup, { token, dryRun = false } = {}) {
  const richText = buildRichText(markup);
  if (dryRun) {
    console.log(JSON.stringify({ parent: { page_id: pageId }, rich_text: richText }, null, 2));
    return;
  }
  if (!token) throw new Error("NOTION_TOKEN manquant dans l'environnement");
  const res = await fetch("https://api.notion.com/v1/comments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ parent: { page_id: pageId }, rich_text: richText }),
  });
  if (!res.ok) throw new Error(`Notion comment: HTTP ${res.status} — ${await res.text()}`);
  console.log(`OK — commentaire riche posté sur la page ${pageId}`);
}

// --- CLI ---------------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const fileFlagIndex = args.indexOf("--file");
  const filePath = fileFlagIndex !== -1 ? args[fileFlagIndex + 1] : undefined;
  const fileValueIndex = fileFlagIndex !== -1 ? fileFlagIndex + 1 : -1;
  const pageId = args.find((a, i) => !a.startsWith("--") && i !== fileValueIndex);

  if (!pageId) {
    console.error("Usage: node scripts/notion-comment.mjs <pageId> [--file message.txt] [--dry-run]");
    console.error("       (sans --file, le message est lu sur stdin)");
    process.exit(1);
  }

  const markup = filePath ? await readFile(filePath, "utf8") : await readStdin();
  if (!markup.trim()) {
    console.error("Message vide — rien à poster.");
    process.exit(1);
  }

  await postComment(pageId, markup.replace(/\n$/, ""), {
    token: process.env.NOTION_TOKEN,
    dryRun,
  });
}

// N'exécuter le CLI que si lancé directement (pas à l'import).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
