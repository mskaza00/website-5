#!/usr/bin/env node
/**
 * Generates, for every photo category and every client shoot folder:
 *   - manifests JSON files
 *   - watermarked WebP thumbnails and display-size images
 *   - sitemap.xml
 *
 * Client gallery images are watermarked directly into the generated WebP
 * pixels. The watermark is constrained using the ACTUAL dimensions of the
 * already-rendered/resized image, preventing Sharp composite dimension errors.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

// Used to build XML without literal angle brackets in this source file.
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
const WATERMARK_WIDTH_RATIO = 0.14;
const WATERMARK_MAX_HEIGHT_RATIO = 0.18;
const WATERMARK_MARGIN_RATIO = 0.03;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function formatSlugLabel(slug) {
  return slug
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function readClientConfig(slug) {
  const configPath = path.join(ROOT, "photos/clients", slug, "config.json");

  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    console.warn(
      "  ! Could not parse config.json for clients/" +
        slug +
        ": " +
        err.message
    );
    return {};
  }
}

function listClientSlugs() {
  const dir = path.join(ROOT, "photos/clients");

  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(function (d) {
      return d.isDirectory();
    })
    .map(function (d) {
      return d.name;
    });
}

/*
 * Cache already-generated watermark PNGs.
 *
 * The cache key is based on the maximum dimensions allowed for the watermark.
 */
const watermarkCache = new Map();

async function getWatermark(maxWmWidth, maxWmHeight) {
  const safeMaxW = Math.max(1, Math.floor(maxWmWidth));
  const safeMaxH = Math.max(1, Math.floor(maxWmHeight));

  const key = safeMaxW + "x" + safeMaxH;

  if (watermarkCache.has(key)) {
    return watermarkCache.get(key);
  }

  /*
   * Resize the logo inside the exact box allowed by the destination image.
   *
   * Then read the actual RGBA pixels and directly multiply every alpha
   * channel by WATERMARK_OPACITY.
   *
   * No blend mode is used.
   */
  const raw = await sharp(WATERMARK_PATH)
    .resize({
      width: safeMaxW,
      height: safeMaxH,
      fit: "inside",
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = raw.data;

  for (let i = 3; i < pixels.length; i += 4) {
    pixels[i] = Math.round(pixels[i] * WATERMARK_OPACITY);
  }

  const buf = await sharp(pixels, {
    raw: {
      width: raw.info.width,
      height: raw.info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();

  const result = {
    buf: buf,
    width: raw.info.width,
    height: raw.info.height,
  };

  watermarkCache.set(key, result);

  return result;
}

/*
 * Resize and optionally watermark an image.
 *
 * IMPORTANT:
 * We render the resized image to a buffer FIRST.
 *
 * The previous version called metadata() on an unexecuted Sharp pipeline.
 * That can report source dimensions instead of the dimensions of the actual
 * resized output. That is what caused:
 *
 *   Image to composite must have same dimensions or smaller
 *
 * on some client photos.
 */
async function writeWatermarked(
  srcAbs,
  outAbs,
  maxWidth,
  applyWatermark
) {
  /*
   * Render the resize first.
   *
   * autoOrient() makes the dimensions correspond to the orientation the
   * viewer actually sees.
   */
  const resizedBuffer = await sharp(srcAbs)
    .autoOrient()
    .resize({
      width: maxWidth,
      withoutEnlargement: true,
    })
    .toBuffer();

  /*
   * Public category images do not need watermarking.
   */
  if (!applyWatermark) {
    await sharp(resizedBuffer)
      .webp({
        quality: IMAGE_QUALITY,
      })
      .toFile(outAbs);

    return;
  }

  /*
   * These are the REAL dimensions of the rendered/resized image.
   */
  const outputMeta = await sharp(resizedBuffer).metadata();

  const outWidth = outputMeta.width;
  const outHeight = outputMeta.height;

  if (!outWidth || !outHeight) {
    throw new Error("could not determine rendered output dimensions");
  }

  /*
   * Keep a small safety boundary around the watermark.
   */
  const availableWidth = Math.max(1, outWidth - 2);
  const availableHeight = Math.max(1, outHeight - 2);

  /*
   * Calculate the maximum watermark box using the ACTUAL output size.
   */
  const maxWmWidth = Math.min(
    availableWidth,
    Math.max(
      1,
      Math.round(outWidth * WATERMARK_WIDTH_RATIO)
    )
  );

  const maxWmHeight = Math.min(
    availableHeight,
    Math.max(
      1,
      Math.round(outHeight * WATERMARK_MAX_HEIGHT_RATIO)
    )
  );

  let watermark = await getWatermark(
    maxWmWidth,
    maxWmHeight
  );

  /*
   * Final defensive check.
   *
   * This happens BEFORE composite(), so Sharp never receives an overlay
   * larger than the destination image.
   */
  if (
    watermark.width > availableWidth ||
    watermark.height > availableHeight
  ) {
    const safeW = Math.min(
      watermark.width,
      availableWidth
    );

    const safeH = Math.min(
      watermark.height,
      availableHeight
    );

    watermark = await getWatermark(
      safeW,
      safeH
    );
  }

  /*
   * Absolute final validation.
   */
  if (
    watermark.width > outWidth ||
    watermark.height > outHeight
  ) {
    throw new Error(
      "watermark is " +
        watermark.width +
        "x" +
        watermark.height +
        " but rendered photo is " +
        outWidth +
        "x" +
        outHeight
    );
  }

  /*
   * Put the watermark in the bottom-right corner.
   */
  const margin = Math.max(
    0,
    Math.round(outWidth * WATERMARK_MARGIN_RATIO)
  );

  const left = Math.max(
    0,
    outWidth - watermark.width - margin
  );

  const top = Math.max(
    0,
    outHeight - watermark.height - margin
  );

  /*
   * Composite onto the already-rendered image.
   */
  await sharp(resizedBuffer)
    .composite([
      {
        input: watermark.buf,
        left: left,
        top: top,
      },
    ])
    .webp({
      quality: IMAGE_QUALITY,
    })
    .toFile(outAbs);
}

async function processFolder(
  photosRel,
  thumbsRel,
  displayRel,
  applyWatermark
) {
  const photosDir = path.join(ROOT, photosRel);

  if (!fs.existsSync(photosDir)) {
    return [];
  }

  ensureDir(path.join(ROOT, thumbsRel));
  ensureDir(path.join(ROOT, displayRel));

  const files = fs
    .readdirSync(photosDir)
    .filter(function (f) {
      return IMAGE_EXT.test(f);
    })
    .sort(function (a, b) {
      return a.localeCompare(b);
    });

  const manifest = [];

  for (const file of files) {
    const srcAbs = path.join(photosDir, file);

    const baseName = file.replace(/\.[^.]+$/, "");

    const thumbRel =
      thumbsRel + "/" + baseName + ".webp";

    const displayRelPath =
      displayRel + "/" + baseName + ".webp";

    try {
      /*
       * Read original dimensions for the manifest.
       */
      const meta = await sharp(srcAbs).metadata();

      const width = meta.width;
      const height = meta.height;

      if (!width || !height) {
        throw new Error("no dimensions found in file");
      }

      /*
       * Generate thumbnail.
       */
      await writeWatermarked(
        srcAbs,
        path.join(ROOT, thumbRel),
        THUMB_MAX_WIDTH,
        applyWatermark
      );

      /*
       * Generate display image.
       */
      await writeWatermarked(
        srcAbs,
        path.join(ROOT, displayRelPath),
        DISPLAY_MAX_WIDTH,
        applyWatermark
      );

      /*
       * Only add the photo to the manifest after BOTH generated files
       * successfully exist.
       */
      manifest.push({
        name: file,
        src: photosRel + "/" + file,
        thumb: thumbRel,
        display: displayRelPath,
        width: width,
        height: height,
        aspectRatio:
          Math.round((width / height) * 10000) / 10000,
      });

      console.log(
        "  ✓ " +
          photosRel +
          "/" +
          file
      );
    } catch (err) {
      /*
       * Keep processing the rest of the folder.
       *
       * This makes the problem obvious in the Action log instead of
       * pretending everything worked.
       */
      console.error(
        "  ! FAILED " +
          photosRel +
          "/" +
          file +
          ": " +
          err.message
      );
    }
  }

  console.log(
    "  Generated " +
      manifest.length +
      "/" +
      files.length +
      " photos in " +
      photosRel
  );

  return manifest;
}

function writeJSON(relPath, data) {
  const abs = path.join(ROOT, relPath);

  ensureDir(path.dirname(abs));

  fs.writeFileSync(
    abs,
    JSON.stringify(data, null, 2) + "\n"
  );

  console.log(
    "Wrote " +
      relPath +
      " (" +
      (Array.isArray(data)
        ? data.length
        : "n/a") +
      " entries)"
  );
}

function escapeXml(s) {
  return String(s)
    .split("&")
    .join("&amp;")
    .split(LT)
    .join("&lt;")
    .split(GT)
    .join("&gt;")
    .split('"')
    .join("&quot;");
}

/*
 * Builds sitemap.
 *
 * LT/GT are used instead of literal angle brackets because this file has
 * previously been corrupted during copy/upload.
 */
function buildSitemap(categoryManifests) {
  const pages = [
    {
      loc: SITE_BASE + "/",
      images: [],
    },
    {
      loc: SITE_BASE + "/sports.html",
      images: categoryManifests.sports || [],
    },
    {
      loc: SITE_BASE + "/portraits.html",
      images: categoryManifests.portraits || [],
    },
    {
      loc: SITE_BASE + "/events.html",
      images: categoryManifests.events || [],
    },
    {
      loc: SITE_BASE + "/gallery.html",
      images: [],
    },
  ];

  const tag = function (name, content) {
    return (
      LT +
      name +
      GT +
      content +
      LT +
      "/" +
      name +
      GT
    );
  };

  let xml =
    LT +
    "?xml version=" +
    '"1.0"' +
    " encoding=" +
    '"UTF-8"' +
    "?" +
    GT +
    "\n";

  xml +=
    LT +
    "urlset xmlns=" +
    '"http://www.sitemaps.org/schemas/sitemap/0.9"' +
    ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"' +
    GT +
    "\n";

  for (const page of pages) {
    xml +=
      "  " +
      LT +
      "url" +
      GT +
      "\n    " +
      tag(
        "loc",
        escapeXml(page.loc)
      ) +
      "\n";

    for (const item of page.images) {
      const readableName = item.name
        .replace(/\.[^.]+$/, "")
        .replace(/[-_]+/g, " ");

      const title =
        "Matthew Skaza Photography (ShotsBySkaza) -- " +
        readableName;

      xml +=
        "    " +
        LT +
        "image:image" +
        GT +
        "\n";

      xml +=
        "      " +
        tag(
          "image:loc",
          escapeXml(
            SITE_BASE +
              "/" +
              item.display
          )
        ) +
        "\n";

      xml +=
        "      " +
        tag(
          "image:title",
          escapeXml(title)
        ) +
        "\n";

      xml +=
        "    " +
        LT +
        "/image:image" +
        GT +
        "\n";
    }

    xml +=
      "  " +
      LT +
      "/url" +
      GT +
      "\n";
  }

  xml +=
    LT +
    "/urlset" +
    GT +
    "\n";

  return xml;
}

async function main() {
  const categoryManifests = {};

  /*
   * Public categories.
   */
  for (const category of CATEGORIES) {
    const manifest = await processFolder(
      "photos/" + category,
      "thumbs/" + category,
      "display/" + category,
      false
    );

    writeJSON(
      "manifests/" +
        category +
        ".json",
      manifest
    );

    categoryManifests[category] =
      manifest;
  }

  /*
   * Client galleries.
   */
  const clientIndex = [];

  for (const slug of listClientSlugs()) {
    const manifest =
      await processFolder(
        "photos/clients/" +
          slug,
        "thumbs/clients/" +
          slug,
        "display/clients/" +
          slug,
        true
      );

    writeJSON(
      "manifests/clients/" +
        slug +
        ".json",
      manifest
    );

    const config =
      readClientConfig(slug);

    let cover = manifest.length
      ? manifest[0].thumb
      : null;

    if (config.thumbnail) {
      const match =
        manifest.find(
          function (m) {
            return (
              m.name ===
              config.thumbnail
            );
          }
        );

      if (match) {
        cover = match.thumb;
      } else {
        console.warn(
          '  ! config.json thumbnail "' +
            config.thumbnail +
            '" not found in clients/' +
            slug
        );
      }
    }

    clientIndex.push({
      slug: slug,
      title:
        config.title ||
        formatSlugLabel(slug),
      date:
        config.date ||
        null,
      count:
        manifest.length,
      cover:
        cover,
      locked:
        !!config.locked,
      passwordHash:
        config.locked &&
        config.password
          ? sha256(config.password)
          : null,
    });
  }

  writeJSON(
    "manifests/clients/index.json",
    clientIndex
  );

  /*
   * Sitemap.
   */
  const sitemapXml =
    buildSitemap(
      categoryManifests
    );

  fs.writeFileSync(
    path.join(
      ROOT,
      "sitemap.xml"
    ),
    sitemapXml
  );

  console.log(
    "Wrote sitemap.xml"
  );
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
