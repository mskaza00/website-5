#!/usr/bin/env node
/**
 * Generates, for every photo category and every client shoot folder:
 *   - manifests JSON files (name, src, thumb, display, width, height, aspectRatio)
 *   - manifests/clients/index.json (slug, title, date, count, cover, locked)
 *   - watermarked WebP thumbnails and display-size images
 *   - sitemap.xml
 *
 * WATERMARKING
 * Every image the site actually links to (thumb + display) has the logo
 * composited into it at reduced opacity, baked into the pixel data, not a
 * CSS overlay. The watermark is sized to fit inside a box constrained by
 * both the photo's width and height, so it always fits regardless of the
 * photo's shape (portrait, landscape, or an ultra-wide panorama).
 *
 * You normally don't need to run this by hand -- the GitHub Action in
 * .github/workflows/generate-manifests.yml runs it automatically every
 * time photos are added, removed, or renamed.
 *
 * Local usage: npm install, then npm run generate-manifest
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

// Used to build XML tags without ever writing a literal angle bracket in
// this source file -- see the note in buildSitemap() for why.
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);

const ROOT = path.join(__dirname, "..");
const CATEGORIES = ["sports", "portraits", "events"];
const THUMB_MAX_WIDTH = 900;
const DISPLAY_MAX_WIDTH = 2000;
const IMAGE_QUALITY = 78;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

const SITE_BASE = "https://shotsbyskaza.com";
const WATERMARK_PATH = path.join(ROOT, "shotsbyskazalogo.png");
const WATERMARK_OPACITY = 0.45;
const WATERMARK_WIDTH_RATIO = 0.4;
const WATERMARK_MAX_HEIGHT_RATIO = 0.4;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function formatSlugLabel(slug) {
  return slug
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function readClientConfig(slug) {
  const configPath = path.join(ROOT, "photos/clients", slug, "config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    console.warn("  ! Could not parse config.json for clients/" + slug + ": " + err.message);
    return {};
  }
}

function listClientSlugs() {
  const dir = path.join(ROOT, "photos/clients");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(function (d) { return d.isDirectory(); })
    .map(function (d) { return d.name; });
}

const watermarkCache = new Map();

async function getWatermark(maxWmWidth, maxWmHeight) {
  const key = maxWmWidth + "x" + maxWmHeight;
  if (watermarkCache.has(key)) return watermarkCache.get(key);

  // Resize the logo to fit inside the box, then read out its raw RGBA
  // pixels and directly multiply every pixel's actual alpha value by
  // WATERMARK_OPACITY. This is plain arithmetic on real pixel data --
  // no reliance on a blend-mode's documented-but-unverified behavior.
  const resizedLogo = sharp(WATERMARK_PATH)
    .resize({ width: maxWmWidth, height: maxWmHeight, fit: "inside" })
    .ensureAlpha();

  const raw = await resizedLogo.raw().toBuffer({ resolveWithObject: true });
  const pixels = raw.data;
  const width = raw.info.width;
  const height = raw.info.height;

  for (let i = 3; i < pixels.length; i += 4) {
    pixels[i] = Math.round(pixels[i] * WATERMARK_OPACITY);
  }

  const buf = await sharp(pixels, { raw: { width: width, height: height, channels: 4 } })
    .png()
    .toBuffer();

  if (width > maxWmWidth || height > maxWmHeight) {
    throw new Error(
      "Watermark came out " + width + "x" + height +
      " against a " + maxWmWidth + "x" + maxWmHeight + " box -- aborting."
    );
  }

  const result = { buf: buf, width: width, height: height };
  watermarkCache.set(key, result);
  return result;
}

async function writeWatermarked(srcAbs, outAbs, maxWidth, applyWatermark) {
  // .rotate() with no args auto-applies the EXIF orientation tag (Canon
  // bodies routinely write orientation 6/8 for portrait shots) and then
  // strips the tag, so both the pixels AND the reported dimensions below
  // are in the final, correctly-oriented shape.
  const resizedPipeline = sharp(srcAbs)
    .rotate()
    .resize({ width: maxWidth, withoutEnlargement: true });

  if (!applyWatermark) {
    await resizedPipeline.webp({ quality: IMAGE_QUALITY }).toFile(outAbs);
    return;
  }

  // ROOT CAUSE FIX: the previous version called `.clone().metadata()` on
  // the resize pipeline to learn the output size. sharp's .metadata()
  // always reports the INPUT image's dimensions -- it does not execute
  // the pipeline, so it never reflects a .resize() call. That mismatch
  // was the actual bug: watermark sizing was computed against the
  // original full-resolution photo instead of the resized thumb/display
  // canvas. toBuffer({ resolveWithObject: true }) actually EXECUTES the
  // pipeline and returns the real output width/height in `info`, which
  // is the only reliable way to get post-resize (and post-rotate)
  // dimensions.
  const resizedResult = await resizedPipeline.toBuffer({ resolveWithObject: true });
  const resizedBuf = resizedResult.data;
  const outWidth = resizedResult.info.width;
  const outHeight = resizedResult.info.height;

  const maxWmWidth = Math.max(20, Math.round(outWidth * WATERMARK_WIDTH_RATIO));
  const maxWmHeight = Math.max(20, Math.round(outHeight * WATERMARK_MAX_HEIGHT_RATIO));
  let watermark = await getWatermark(maxWmWidth, maxWmHeight);

  // Defensive hard clamp: re-resize the watermark against this specific
  // photo's actual real dimensions right before compositing, so a
  // rounding quirk from the cached box size can never cause a mismatch.
  const safeWidth = Math.min(watermark.width, Math.max(1, outWidth - 2));
  const safeHeight = Math.min(watermark.height, Math.max(1, outHeight - 2));
  if (safeWidth < watermark.width || safeHeight < watermark.height) {
    const reclamped = await sharp(watermark.buf)
      .resize({ width: safeWidth, height: safeHeight, fit: "inside", withoutEnlargement: true })
      .toBuffer();
    const reclampedMeta = await sharp(reclamped).metadata();
    watermark = { buf: reclamped, width: reclampedMeta.width, height: reclampedMeta.height };
  }

  // Centered, both horizontally and vertically, on the actual resized
  // canvas — outWidth/outHeight are the real post-resize dimensions (see
  // the ROOT CAUSE FIX note above), so this stays centered regardless of
  // the photo's original resolution or aspect ratio.
  const left = Math.max(0, Math.round((outWidth - watermark.width) / 2));
  const top = Math.max(0, Math.round((outHeight - watermark.height) / 2));

  // Composite onto the ALREADY-RESIZED buffer (not a fresh pipeline off
  // the original file), so there is no chance of compositing the
  // correctly-sized watermark onto a different, un-resized canvas.
  await sharp(resizedBuf)
    .composite([{ input: watermark.buf, left: left, top: top }])
    .webp({ quality: IMAGE_QUALITY })
    .toFile(outAbs);
}

async function processFolder(photosRel, thumbsRel, displayRel, applyWatermark) {
  const photosDir = path.join(ROOT, photosRel);
  if (!fs.existsSync(photosDir)) return [];

  ensureDir(path.join(ROOT, thumbsRel));
  ensureDir(path.join(ROOT, displayRel));

  const files = fs
    .readdirSync(photosDir)
    .filter(function (f) { return IMAGE_EXT.test(f); })
    .sort(function (a, b) { return a.localeCompare(b); });

  const manifest = [];

  for (const file of files) {
    const srcAbs = path.join(photosDir, file);
    const baseName = file.replace(/\.[^.]+$/, "");
    const thumbRel = thumbsRel + "/" + baseName + ".webp";
    const displayRelPath = displayRel + "/" + baseName + ".webp";

    try {
      const meta = await sharp(srcAbs).metadata();
      let width = meta.width;
      let height = meta.height;
      if (!width || !height) throw new Error("no dimensions found in file");

      // Canon (and most camera) JPEGs commonly carry an EXIF orientation
      // tag of 6 or 8 for portrait-held shots. sharp's metadata() reports
      // the raw stored pixel grid, not the visually-correct shape, and
      // writeWatermarked() above now auto-rotates via .rotate(). Swap
      // width/height here too so the manifest's aspectRatio (used for
      // layout) matches the actual output image instead of the raw file.
      if (meta.orientation && meta.orientation >= 5) {
        const swap = width;
        width = height;
        height = swap;
      }

      await writeWatermarked(srcAbs, path.join(ROOT, thumbRel), THUMB_MAX_WIDTH, applyWatermark);
      await writeWatermarked(srcAbs, path.join(ROOT, displayRelPath), DISPLAY_MAX_WIDTH, applyWatermark);

      manifest.push({
        name: file,
        src: photosRel + "/" + file,
        thumb: thumbRel,
        display: displayRelPath,
        width: width,
        height: height,
        aspectRatio: Math.round((width / height) * 10000) / 10000,
      });
    } catch (err) {
      console.warn("  ! Skipping " + photosRel + "/" + file + ": " + err.message);
    }
  }

  return manifest;
}

function writeJSON(relPath, data) {
  const abs = path.join(ROOT, relPath);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + "\n");
  console.log("Wrote " + relPath + " (" + (Array.isArray(data) ? data.length : "n/a") + " entries)");
}

function escapeXml(s) {
  return String(s)
    .split("&").join("&amp;")
    .split(LT).join("&lt;")
    .split(GT).join("&gt;")
    .split('"').join("&quot;");
}

/** Builds the sitemap using LT/GT (defined at the top of this file) instead
 *  of literal angle-bracket characters. This file kept getting silently
 *  corrupted somewhere in the copy/upload path -- something along the way
 *  appears to treat bracketed placeholder text as an HTML tag and strips
 *  it, which broke a real declaration in an earlier version of this
 *  script. Avoiding literal angle brackets entirely sidesteps that,
 *  whatever the actual cause turns out to be. */
function buildSitemap(categoryManifests) {
  const pages = [
    { loc: SITE_BASE + "/", images: [] },
    { loc: SITE_BASE + "/sports.html", images: categoryManifests.sports || [] },
    { loc: SITE_BASE + "/portraits.html", images: categoryManifests.portraits || [] },
    { loc: SITE_BASE + "/events.html", images: categoryManifests.events || [] },
    { loc: SITE_BASE + "/gallery.html", images: [] },
  ];

  const tag = function (name, content) { return LT + name + GT + content + LT + "/" + name + GT; };

  let xml = LT + "?xml version=" + '"1.0"' + " encoding=" + '"UTF-8"' + "?" + GT + "\n";
  xml += LT + "urlset xmlns=" + '"http://www.sitemaps.org/schemas/sitemap/0.9"' +
    ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"' + GT + "\n";

  for (const page of pages) {
    xml += "  " + LT + "url" + GT + "\n    " + tag("loc", escapeXml(page.loc)) + "\n";
    for (const item of page.images) {
      const readableName = item.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
      const title = "Matthew Skaza Photography (ShotsBySkaza) -- " + readableName;
      xml += "    " + LT + "image:image" + GT + "\n";
      xml += "      " + tag("image:loc", escapeXml(SITE_BASE + "/" + item.display)) + "\n";
      xml += "      " + tag("image:title", escapeXml(title)) + "\n";
      xml += "    " + LT + "/image:image" + GT + "\n";
    }
    xml += "  " + LT + "/url" + GT + "\n";
  }

  xml += LT + "/urlset" + GT + "\n";
  return xml;
}

async function main() {
  const categoryManifests = {};

  for (const category of CATEGORIES) {
    const manifest = await processFolder("photos/" + category, "thumbs/" + category, "display/" + category, false);
    writeJSON("manifests/" + category + ".json", manifest);
    categoryManifests[category] = manifest;
  }

  const clientIndex = [];
  for (const slug of listClientSlugs()) {
    const manifest = await processFolder(
      "photos/clients/" + slug,
      "thumbs/clients/" + slug,
      "display/clients/" + slug,
      true
    );
    writeJSON("manifests/clients/" + slug + ".json", manifest);

    const config = readClientConfig(slug);

    let cover = manifest.length ? manifest[0].thumb : null;
    if (config.thumbnail) {
      const match = manifest.find(function (m) { return m.name === config.thumbnail; });
      if (match) cover = match.thumb;
      else console.warn('  ! config.json thumbnail "' + config.thumbnail + '" not found in clients/' + slug);
    }

    clientIndex.push({
      slug: slug,
      title: config.title || formatSlugLabel(slug),
      date: config.date || null,
      count: manifest.length,
      cover: cover,
      locked: !!config.locked,
      passwordHash: config.locked && config.password ? sha256(config.password) : null,
    });
  }
  writeJSON("manifests/clients/index.json", clientIndex);

  const sitemapXml = buildSitemap(categoryManifests);
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemapXml);
  console.log("Wrote sitemap.xml");
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
