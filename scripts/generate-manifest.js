#!/usr/bin/env node
/**
 * Generates, for every photo category and every client shoot folder:
 *   - manifests/<category>.json        (name, src, thumb, display, width, height, aspectRatio)
 *   - manifests/clients/<slug>.json    (same shape, one per client shoot)
 *   - manifests/clients/index.json     (slug/title/date/count/cover/locked for the hub)
 *   - thumbs/<category>/<name>.webp    (small watermarked grid thumbnail)
 *   - display/<category>/<name>.webp   (larger watermarked version — what the
 *                                        lightbox shows; the true original in
 *                                        photos/ is never linked from the site)
 *   - sitemap.xml
 *
 * WATERMARKING
 * Every image the site actually links to (thumb + display) has the logo
 * composited into it at reduced opacity, baked into the pixel data — not a
 * CSS overlay. A saved/screenshotted copy keeps the watermark because it's
 * physically part of the file. The true, un-watermarked original still sits
 * in photos/<category>/<name> in this repo (not linked from the site), so
 * if you need this repo to guarantee originals are unreachable by anyone,
 * that's a separate step: don't commit true originals into a public repo at
 * all — keep them private and only commit already-processed derivatives.
 *
 * You normally don't need to run this by hand — the GitHub Action in
 * .github/workflows/generate-manifests.yml runs it automatically every
 * time photos are added, removed, or renamed.
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
const DISPLAY_MAX_WIDTH = 2000;
const IMAGE_QUALITY = 78;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i; // note: AVIF isn't supported by sharp's default build in all environments

const SITE_BASE = "https://shotsbyskaza.com";
const WATERMARK_PATH = path.join(ROOT, "shotsbyskazalogo.png");
const WATERMARK_OPACITY = 0.45; // 0 (invisible) – 1 (solid)
const WATERMARK_WIDTH_RATIO = 0.14; // watermark width as a fraction of the photo's width
const WATERMARK_MARGIN_RATIO = 0.03; // inset from the edge, as a fraction of the photo's width

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
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
 *  secret. */
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

function listClientSlugs() {
  const dir = path.join(ROOT, "photos/clients");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Builds a semi-transparent version of the logo, sized relative to
const WATERMARK_MAX_HEIGHT_RATIO = 0.18; // watermark height as a fraction of the photo's height

/** Builds a semi-transparent version of the logo, scaled to fit inside a
 *  maxWidth x maxHeight box (whichever dimension is tighter wins) — this
 *  is what guarantees the watermark always fits the photo regardless of
 *  its shape (portrait, landscape, or an ultra-wide panorama). Cached per
 *  box size so we don't redo this for every photo. */
const watermarkCache = new Map();

async function getWatermark(maxWmWidth, maxWmHeight) {
  const key = `${maxWmWidth}x${maxWmHeight}`;
  if (watermarkCache.has(key)) return watermarkCache.get(key);

  const alpha = Math.round(255 * WATERMARK_OPACITY);
  const buf = await sharp(WATERMARK_PATH)
    .resize({ width: maxWmWidth, height: maxWmHeight, fit: "inside" })
    .ensureAlpha()
    .composite([
      {
        input: Buffer.from([255, 255, 255, alpha]),
        raw: { width: 1, height: 1, channels: 4 },
        tile: true,
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();

  const meta = await sharp(buf).metadata();

  // Safety net: fit:"inside" against both bounds should make this
  // impossible, but confirm anyway rather than silently shipping
  // something that fails to composite.
  if (meta.width > maxWmWidth || meta.height > maxWmHeight) {
    throw new Error(
      `Watermark came out ${meta.width}x${meta.height} against a ${maxWmWidth}x${maxWmHeight} box — ` +
        `aborting instead of risking a failed composite.`
    );
  }

  const result = { buf, width: meta.width, height: meta.height };
  watermarkCache.set(key, result);
  return result;
}

/** Resizes srcAbs to maxWidth, composites the watermark inset from the
 *  bottom-right corner by an explicit margin (never clipped, since the
 *  position is computed from the watermark's actual measured size), and
 *  writes the result as WebP to outAbs. */
async function writeWatermarked(srcAbs, outAbs, maxWidth) {
  const resized = sharp(srcAbs).resize({ width: maxWidth, withoutEnlargement: true });
  const resizedMeta = await resized.clone().metadata();
  const outWidth = resizedMeta.width;
  const outHeight = resizedMeta.height;

  const maxWmWidth = Math.max(20, Math.round(outWidth * WATERMARK_WIDTH_RATIO));
  const maxWmHeight = Math.max(20, Math.round(outHeight * WATERMARK_MAX_HEIGHT_RATIO));
  const watermark = await getWatermark(maxWmWidth, maxWmHeight);

  const margin = Math.round(outWidth * WATERMARK_MARGIN_RATIO);
  const left = Math.max(0, outWidth - watermark.width - margin);
  const top = Math.max(0, outHeight - watermark.height - margin);

  await resized
    .composite([{ input: watermark.buf, left, top }])
    .webp({ quality: IMAGE_QUALITY })
    .toFile(outAbs);
}

/** Reads real dimensions, then writes a watermarked thumbnail (thumbs/)
 *  and a watermarked larger display version (display/) for every image in
 *  photosRel. Returns the manifest array for that folder. */
async function processFolder(photosRel, thumbsRel, displayRel) {
  const photosDir = path.join(ROOT, photosRel);
  if (!fs.existsSync(photosDir)) return [];

  ensureDir(path.join(ROOT, thumbsRel));
  ensureDir(path.join(ROOT, displayRel));

  const files = fs
    .readdirSync(photosDir)
    .filter((f) => IMAGE_EXT.test(f))
    .sort((a, b) => a.localeCompare(b));

  const manifest = [];

  for (const file of files) {
    const srcAbs = path.join(photosDir, file);
    const baseName = file.replace(/\.[^.]+$/, "");
    const thumbRel = `${thumbsRel}/${baseName}.webp`;
    const displayRelPath = `${displayRel}/${baseName}.webp`;

    try {
      const meta = await sharp(srcAbs).metadata();
      const width = meta.width;
      const height = meta.height;
      if (!width || !height) throw new Error("no dimensions found in file");

      await writeWatermarked(srcAbs, path.join(ROOT, thumbRel), THUMB_MAX_WIDTH);
      await writeWatermarked(srcAbs, path.join(ROOT, displayRelPath), DISPLAY_MAX_WIDTH);

      manifest.push({
        name: file,
        src: `${photosRel}/${file}`, // true original — not linked from the site UI
        thumb: thumbRel,
        display: displayRelPath,
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

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Builds an XML sitemap with Google's <image:image> extension, pointing
 *  at the watermarked display versions (what's actually publicly linked). */
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
      xml += `      <image:loc>${escapeXml(`${SITE_BASE}/${item.display}`)}</image:loc>\n`;
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
    const manifest = await processFolder(`photos/${category}`, `thumbs/${category}`, `display/${category}`);
    writeJSON(`manifests/${category}.json`, manifest);
    categoryManifests[category] = manifest;
  }

  const clientIndex = [];
  for (const slug of listClientSlugs()) {
    const manifest = await processFolder(
      `photos/clients/${slug}`,
      `thumbs/clients/${slug}`,
      `display/clients/${slug}`
    );
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
