#!/usr/bin/env node
// Attache une image (typiquement une capture `browser_screenshot`) à une
// page/carte Notion comme **bloc image**, via l'API File Upload de Notion.
//
// C'est le pendant "preuve" du commentaire de handoff : là où `coderhammer/spunto`
// a un script d'enregistrement vidéo (ffmpeg), spunto-lite n'a pas de vidéo — la
// preuve d'une feature UI est une capture PNG, hébergée de façon **permanente**
// par Notion et affichée dans le corps de la carte.
//
// Flux File Upload en 3 étapes (cf. record-browser-test.js côté spunto) :
//   1) POST /v1/file_uploads          → { id, upload_url }
//   2) POST <upload_url> (multipart)  → envoie les octets, status "uploaded"
//   3) PATCH /v1/blocks/<pageId>/children avec un bloc image référençant l'id
//
// Usage :
//   node scripts/notion-attach-image.mjs <pageId> <fichier.png> [--caption "…"]
//   node scripts/notion-attach-image.mjs <pageId> <fichier.png> --dry-run
//
// Requiert NOTION_TOKEN dans l'environnement (déjà injecté dans tout worker via
// les secrets), sauf en --dry-run. Limite Notion : 5 Mo/fichier (une capture
// fait quelques dizaines/centaines de Ko).

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const NOTION_VERSION = process.env.NOTION_VERSION || "2022-06-28";
const NOTION_API = "https://api.notion.com/v1";

const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function contentTypeFor(filename) {
  return CONTENT_TYPES[extname(filename).toLowerCase()] || "application/octet-stream";
}

export async function attachImage(pageId, filePath, { token, caption, dryRun = false } = {}) {
  const filename = basename(filePath);
  const contentType = contentTypeFor(filename);

  if (dryRun) {
    console.log(JSON.stringify({ pageId, filename, contentType, caption }, null, 2));
    return;
  }
  if (!token) throw new Error("NOTION_TOKEN manquant dans l'environnement");

  const bytes = await readFile(filePath);
  const auth = { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION };

  // 1) créer le file_upload → { id, upload_url }
  const createRes = await fetch(`${NOTION_API}/file_uploads`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ filename, content_type: contentType }),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    throw new Error(`Notion create file_upload: HTTP ${createRes.status} — ${JSON.stringify(created)}`);
  }

  // 2) envoyer les octets (multipart, champ `file`)
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), filename);
  const sendRes = await fetch(created.upload_url, { method: "POST", headers: auth, body: form });
  const sent = await sendRes.json();
  if (!sendRes.ok) {
    throw new Error(`Notion send file_upload: HTTP ${sendRes.status} — ${JSON.stringify(sent)}`);
  }

  // 3) append d'un bloc image référençant le file_upload
  const image = { type: "file_upload", file_upload: { id: created.id } };
  if (caption) image.caption = [{ type: "text", text: { content: caption } }];
  const appendRes = await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ children: [{ object: "block", type: "image", image }] }),
  });
  if (!appendRes.ok) {
    throw new Error(`Notion append image block: HTTP ${appendRes.status} — ${await appendRes.text()}`);
  }
  console.log(`OK — image ${filename} attachée à la page ${pageId}`);
}

// --- CLI ---------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const capIndex = args.indexOf("--caption");
  const caption = capIndex !== -1 ? args[capIndex + 1] : undefined;
  const capValueIndex = capIndex !== -1 ? capIndex + 1 : -1;
  const [pageId, filePath] = args.filter((a, i) => !a.startsWith("--") && i !== capValueIndex);

  if (!pageId || !filePath) {
    console.error("Usage: node scripts/notion-attach-image.mjs <pageId> <fichier.png> [--caption \"…\"] [--dry-run]");
    process.exit(1);
  }

  await attachImage(pageId, filePath, { token: process.env.NOTION_TOKEN, caption, dryRun });
}

// N'exécuter le CLI que si lancé directement (pas à l'import).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
