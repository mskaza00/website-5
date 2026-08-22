#!/usr/bin/env node
/**
 * Generates, for every photo category and every client shoot folder:
 *   - manifests/<category>.json        (name, src, thumb, width, height, aspectRatio)
 *   - manifests/clients/<slug>.json    (same shape, one per client shoot)
 *   - manifests/clients/index.json     (slug/count/cover for the Client Galleries hub)
 *   - thumbs/<category>/<name>.webp    (auto-generated WebP thumbnails)
 *   - thumbs/clients/<slug>/<name>.webp
 *
 * You normally don't need to run this by hand — the GitHub Action in
 * .github/workflows/generate-manifests.yml runs it automatically every
 * time photos are added, removed, or renamed. It's here in case you
 * ever want to run it locally too.
 *
 * Local usage:
 *   npm install
 *   npm run generate-manifest
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const CATEGORIES = ["sports", "portraits", "events"];
const THUMB_MAX_WIDTH = 900;
const THUMB_QUALITY = 78;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i; // note: AVIF isn't supported by sharp's default build in all environments

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** Reads real dimensions + writes a WebP thumbnail for every image in
 *  photosRel, returning the manifest array for that folder. */
async function processFolder(photosRel, thumbsRel) {
  const photosDir = path.join(ROOT, photosRel);
  if (!fs.existsSync(photosDir)) return [];

  const thumbsDir = path.join(ROOT, thumbsRel);
  ensureDir(thumbsDir);

  const files = fs
    .readdirSync(photosDir)
    .filter((f) => IMAGE_EXT.test(f))
    .sort((a, b) => a.localeCompare(b));

  const manifest = [];

  for (const file of files) {
    const srcAbs = path.join(photosDir, file);
    const baseName = file.replace(/\.[^.]+$/, "");
    const thumbRel = `${thumbsRel}/${baseName}.webp`;
    const thumbAbs = path.join(ROOT, thumbRel);

    try {
      const meta = await sharp(srcAbs).metadata();
      const width = meta.width;
      const height = meta.height;
      if (!width || !height) throw new Error("no dimensions found in file");

      await sharp(srcAbs)
        .resize({ width: THUMB_MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: THUMB_QUALITY })
        .toFile(thumbAbs);

      manifest.push({
        name: file,
        src: `${photosRel}/${file}`,
        thumb: thumbRel,
        width,
        height,
        aspectRatio: Math.round((width / height) * 10000) / 10000,
      });
    } catch (err) {
      console.warn(`  ! Skipping ${photosRel}/${file}: ${err.message}`);
    }
  }

  return manifest;
}

function writeJSON(relPath, data) {
  const abs = path.join(ROOT, relPath);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + "\n");
  console.log(`Wrote ${relPath} (${Array.isArray(data) ? data.length : "n/a"} entries)`);
}

function listClientSlugs() {
  const dir = path.join(ROOT, "photos/clients");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function formatSlugLabel(slug) {
  return slug
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Reads photos/clients/<slug>/config.json if it exists. Every field is
 *  optional:
 *    { "title": "...", "date": "YYYY-MM-DD", "thumbnail": "IMG_1052.webp",
 *      "locked": true, "password": "plaintext-here" }
 *  The plaintext password (if any) is hashed below and never written to
 *  the public manifest — only the hash is. config.json itself still lives
 *  in the repo, so treat it as "hidden from casual visitors," not truly
 *  secret — see the README note on this. */
function readClientConfig(slug) {
  const configPath = path.join(ROOT, "photos/clients", slug, "config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    console.warn(`  ! Could not parse config.json for clients/${slug}: ${err.message}`);
    return {};
  }
}

const SITE_BASE = "https://shotsbyskaza.com";

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Builds an XML sitemap with Google's <image:image> extension so every
 *  photo has a direct, crawlable URL — independent of the lazy-loading
 *  used on the live page (which Google's crawler may not fully trigger
 *  on a long scrolling gallery). */
function buildSitemap(categoryManifests) {
  const pages = [
    { loc: `${SITE_BASE}/`, images: [] },
    { loc: `${SITE_BASE}/sports.html`, images: categoryManifests.sports || [] },
    { loc: `${SITE_BASE}/portraits.html`, images: categoryManifests.portraits || [] },
    { loc: `${SITE_BASE}/events.html`, images: categoryManifests.events || [] },
    { loc: `${SITE_BASE}/gallery.html`, images: [] },
  ];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n`;

  for (const page of pages) {
    xml += `  <url>\n    <loc>${escapeXml(page.loc)}</loc>\n`;
    for (const item of page.images) {
      const readableName = item.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
      const title = `Matthew Skaza Photography (ShotsBySkaza) — ${readableName}`;
      xml += `    <image:image>\n`;
      xml += `      <image:loc>${escapeXml(`${SITE_BASE}/${item.src}`)}</image:loc>\n`;
      xml += `      <image:title>${escapeXml(title)}</image:title>\n`;
      xml += `    </image:image>\n`;
    }
    xml += `  </url>\n`;
  }

  xml += `</urlset>\n`;
  return xml;
}

async function main() {
  const categoryManifests = {};

  for (const category of CATEGORIES) {
    const manifest = await processFolder(`photos/${category}`, `thumbs/${category}`);
    writeJSON(`manifests/${category}.json`, manifest);
    categoryManifests[category] = manifest;
  }

  const clientIndex = [];
  for (const slug of listClientSlugs()) {
    const manifest = await processFolder(`photos/clients/${slug}`, `thumbs/clients/${slug}`);
    writeJSON(`manifests/clients/${slug}.json`, manifest);

    const config = readClientConfig(slug);

    let cover = manifest.length ? manifest[0].thumb : null;
    if (config.thumbnail) {
      const match = manifest.find((m) => m.name === config.thumbnail);
      if (match) cover = match.thumb;
      else console.warn(`  ! config.json thumbnail "${config.thumbnail}" not found in clients/${slug}`);
    }

    clientIndex.push({
      slug,
      title: config.title || formatSlugLabel(slug),
      date: config.date || null,
      count: manifest.length,
      cover,
      locked: !!config.locked,
      passwordHash: config.locked && config.password ? sha256(config.password) : null,
    });
  }
  writeJSON("manifests/clients/index.json", clientIndex);

  const sitemapXml = buildSitemap(categoryManifests);
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemapXml);
  console.log("Wrote sitemap.xml");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
