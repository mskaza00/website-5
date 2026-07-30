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

async function main() {
  for (const category of CATEGORIES) {
    const manifest = await processFolder(`photos/${category}`, `thumbs/${category}`);
    writeJSON(`manifests/${category}.json`, manifest);
  }

  const clientIndex = [];
  for (const slug of listClientSlugs()) {
    const manifest = await processFolder(`photos/clients/${slug}`, `thumbs/clients/${slug}`);
    writeJSON(`manifests/clients/${slug}.json`, manifest);
    clientIndex.push({
      slug,
      count: manifest.length,
      cover: manifest.length ? manifest[0].thumb : null,
    });
  }
  writeJSON("manifests/clients/index.json", clientIndex);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
