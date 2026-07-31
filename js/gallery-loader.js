/* =============================================================
   ShotsBySkaza — photo loader
   Reads pre-generated manifest files (see /manifests) for the photo
   list, dimensions, thumbnail path, and full-resolution path for each
   category. Manifests + WebP thumbnails are generated automatically by
   a GitHub Action (.github/workflows/generate-manifests.yml) every time
   photos are added or removed — nothing to run by hand.

   HOW IT WORKS
   - manifests/<category>.json lists every photo in that category, e.g.
     manifests/sports.json, manifests/clients/<slug>.json.
   - manifests/clients/index.json lists every client gallery folder, for
     the Client Galleries hub page.
   - The gallery displays each photo's small WebP thumbnail. The
     lightbox (see main.js) opens the full-resolution original only when
     a photo is actually clicked.
   - A photo's real width/height (from the manifest) is used to place it
     into whichever masonry column is currently shortest — true masonry,
     no cropping, no reordering after placement.
   - Thumbnails are lazy: an <img> only gets a real src once it's near
     the viewport (see sbsLazyLoadObserver below).

   IF A MANIFEST IS MISSING
   That just means the Action hasn't generated it yet for that folder
   (e.g. right after adding a brand-new category or client folder) — the
   affected gallery shows its normal "no photos yet" empty state rather
   than an error. It resolves itself on the next push.
   ============================================================= */

const SBS_REPO_OWNER = "mskaza00";
const SBS_REPO_NAME = "website-5";

function sbsRawUrl(relPath) {
  return `https://raw.githubusercontent.com/${SBS_REPO_OWNER}/${SBS_REPO_NAME}/main/${relPath}`;
}

function sbsFormatLabel(slug) {
  return slug
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// How long a fetched manifest is trusted before asking GitHub again.
const SBS_CACHE_TTL_MS = 2 * 60 * 1000;

const SBS_JSON_CACHE = new Map();

/* Fetches and caches any JSON file from the repo (manifests, the client
   index, etc). Returns [] on a 404 or network error rather than
   throwing — a missing manifest is a normal, temporary state, not a
   bug, so callers don't need their own try/catch around this. */
async function sbsLoadManifest(relPath) {
  if (SBS_JSON_CACHE.has(relPath)) return SBS_JSON_CACHE.get(relPath);

  const cacheKey = `sbs-cache:${relPath}`;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed.t === "number" && Date.now() - parsed.t < SBS_CACHE_TTL_MS) {
        SBS_JSON_CACHE.set(relPath, parsed.data);
        return parsed.data;
      }
    }
  } catch (e) {
    /* skip cache on error */
  }

  let data = [];
  try {
    const res = await fetch(sbsRawUrl(relPath));
    if (res.ok) data = await res.json();
  } catch (e) {
    /* network error — fall through with empty data */
  }

  SBS_JSON_CACHE.set(relPath, data);
  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), data }));
  } catch (e) {
    /* skip cache on error */
  }

  return data;
}

/* Homepage exclude list — a plain-text file in the repo root. Filenames
   listed there are skipped from the homepage combined feed only; they
   still show up normally on their own category page. */
let SBS_EXCLUDE_CACHE = null;

async function sbsLoadExcludeList() {
  if (SBS_EXCLUDE_CACHE) return SBS_EXCLUDE_CACHE;

  const cacheKey = "sbs-cache:homepage-exclude.txt";
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed.t === "number" && Date.now() - parsed.t < SBS_CACHE_TTL_MS) {
        SBS_EXCLUDE_CACHE = new Set(parsed.data);
        return SBS_EXCLUDE_CACHE;
      }
    }
  } catch (e) {
    /* skip cache on error */
  }

  try {
    const res = await fetch(sbsRawUrl("homepage-exclude.txt"));
    if (res.ok) {
      const text = await res.text();
      const names = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      SBS_EXCLUDE_CACHE = new Set(names);
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), data: names }));
      } catch (e) {
        /* skip cache on error */
      }
    } else {
      SBS_EXCLUDE_CACHE = new Set();
    }
  } catch (e) {
    SBS_EXCLUDE_CACHE = new Set();
  }

  return SBS_EXCLUDE_CACHE;
}

/* Converts a manifest entry (repo-relative paths) into what the renderer
   needs (full raw URLs, ready to use as src/href). */
function sbsManifestItemToRenderItem(entry) {
  return {
    name: entry.name,
    width: entry.width,
    height: entry.height,
    thumbUrl: sbsRawUrl(entry.thumb || entry.src),
    fullUrl: sbsRawUrl(entry.src),
  };
}

function sbsRenderPhotoCard(item, label) {
  const card = document.createElement("a");
  card.href = item.fullUrl; // full-resolution original — opens if a visitor middle-clicks/opens in new tab
  card.className = "photo-card";
  card.target = "_blank";
  card.rel = "noopener";
  card.dataset.full = item.fullUrl; // used by the lightbox — original only loads on click
  card.dataset.caption = label ? `${label} — ${item.name}` : item.name;

  // Reserve the card's real, exact size immediately — before the thumbnail
  // loads — using the width/height we already have from the manifest.
  // Without this, an <img> with no src yet has ~0 height, so the whole
  // gallery collapses to a sliver at first paint and IntersectionObserver
  // (correctly) reports nearly everything as "in view" no matter what
  // rootMargin is set to. This is the actual fix for that.
  if (item.width && item.height) {
    card.style.aspectRatio = `${item.width} / ${item.height}`;
  }

  const img = document.createElement("img");
  img.dataset.src = item.thumbUrl; // thumbnail — real src assigned by sbsLazyLoadObserver below
  img.alt = label ? `${label} photo by Shots By Skaza` : "Photo by Shots By Skaza";
  card.appendChild(img);

  const a = document.createElement("span");
  a.className = "corner-a";
  const b = document.createElement("span");
  b.className = "corner-b";
  card.appendChild(a);
  card.appendChild(b);

  return card;
}

/* Only assigns the real thumbnail src once an image is genuinely near
   the viewport. Works safely with the JS-built columns below because
   each column is plain block flow — no global layout/balance step
   exists that could be thrown off by images resolving at different
   times, and thumbnails are small (WebP, ~900px wide) either way. */
const sbsLazyLoadObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const img = entry.target;
      if (img.dataset.src) {
        img.src = img.dataset.src;
        delete img.dataset.src;
      }
      sbsLazyLoadObserver.unobserve(img);
    });
  },
  { rootMargin: "150px 0px" }
);

function sbsFinishContainer(container) {
  window.SBS_observeCards && window.SBS_observeCards(container);
  window.SBS_registerLightboxGroup && window.SBS_registerLightboxGroup(container);
}

/* ---------------- JS-built masonry columns ----------------
   Each photo's real (manifest-supplied) height determines which column
   it's assigned to — always the currently shortest one, exactly like
   traditional Pinterest-style masonry. Assignment happens once, up
   front, before any thumbnail has loaded, so a photo can never later
   jump to a different column or shuffle another photo's position —
   only the column it's already in can grow. */

function sbsGetColumnCount() {
  const w = window.innerWidth;
  if (w >= 1900) return 4;
  if (w >= 1100) return 3;
  return 2;
}

function sbsBuildColumns(container, count) {
  container.innerHTML = "";
  const cols = [];
  for (let i = 0; i < count; i++) {
    const col = document.createElement("div");
    col.className = "masonry-col";
    container.appendChild(col);
    cols.push(col);
  }
  return cols;
}

function sbsRenderCards(container, entries, label) {
  const count = sbsGetColumnCount();
  const cols = sbsBuildColumns(container, count);
  const colHeights = new Array(count).fill(0);

  const REF_WIDTH = 300; // arbitrary reference width — only used to compare relative heights
  const cards = entries.map((entryWrapper) => {
    const item = entryWrapper.entry || entryWrapper;
    const itemLabel = entryWrapper.label !== undefined ? entryWrapper.label : label;
    const card = sbsRenderPhotoCard(item, itemLabel);

    const estHeight = item.width && item.height ? (item.height / item.width) * REF_WIDTH : REF_WIDTH;

    let shortest = 0;
    for (let c = 1; c < count; c++) {
      if (colHeights[c] < colHeights[shortest]) shortest = c;
    }
    cols[shortest].appendChild(card);
    colHeights[shortest] += estHeight;

    return card;
  });

  cards.forEach((card) => {
    const img = card.querySelector("img");
    if (img) sbsLazyLoadObserver.observe(img);
  });

  container.dataset.sbsColumns = String(count);
  container._sbsEntries = entries;
  container._sbsLabel = label;

  sbsFinishContainer(container);
}

// Rebuild columns if the viewport crosses a breakpoint (2/3/4 columns), so
// photos redistribute cleanly instead of staying stuck at a column count
// meant for a different screen size.
let sbsResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(sbsResizeTimer);
  sbsResizeTimer = setTimeout(() => {
    const count = sbsGetColumnCount();
    document.querySelectorAll(".masonry[data-sbs-columns]").forEach((container) => {
      if (Number(container.dataset.sbsColumns) === count) return;
      if (!container._sbsEntries) return;
      sbsRenderCards(container, container._sbsEntries, container._sbsLabel);
    });
  }, 200);
});

/* Single category (Portraits / Sports / Events pages, and client galleries —
   folderPath "photos/clients/<slug>" maps to manifests/clients/<slug>.json) */
async function sbsLoadGallery(containerId, folderPath, label) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.classList.add("is-loading");

  const category = folderPath.replace(/^photos\//, "");

  try {
    const manifest = await sbsLoadManifest(`manifests/${category}.json`);
    const items = manifest.map(sbsManifestItemToRenderItem);

    container.classList.remove("is-loading");

    if (!items.length) {
      container.innerHTML = `<div class="gallery-empty">No photos here yet. Drop images into <code>${folderPath}/</code> on GitHub — they'll appear here automatically after thumbnails finish generating (usually under a minute).</div>`;
      return;
    }

    sbsRenderCards(container, items, label);
  } catch (err) {
    container.classList.remove("is-loading");
    container.innerHTML = `<div class="gallery-error">Couldn't load photos right now (${err.message}).</div>`;
  }
}

/* Homepage priority photos — these specific filenames (matched across
   whichever category they actually live in) appear first on the
   homepage, in this exact order. Everything else keeps the normal
   sports/portraits/events interleave after them. Edit this list directly
   to change which photos lead the homepage, or remove entries to go
   back to plain interleaving for everyone. */
const SBS_HOMEPAGE_PRIORITY = [
  "0001-IMG_4713.webp",
  "0002-_F2A1700.webp",
  "0003-IMG_8338.webp",
  "0004-IMG_6066.webp",
  "0005-IMG_7500.webp",
  "0006-IMG_8889.webp",
  "0007-IMG_5476.webp",
  "0008-IMG_20981.webp",
  "0009-fe__1.912.webp",
  "0010-IMG_3420-2.webp",
  "0011-_F2A6196.webp",
  "0012-IMG_5849.webp",
  "0013-IMG_9846.webp",
];

/* Combined homepage feed — merges several categories, interleaved */
async function sbsLoadCombinedGallery(containerId, folders) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.classList.add("is-loading");

  try {
    const excluded = await sbsLoadExcludeList();

    const perFolder = await Promise.all(
      folders.map(async (f) => {
        try {
          const category = f.path.replace(/^photos\//, "");
          const manifest = await sbsLoadManifest(`manifests/${category}.json`);
          return manifest
            .filter((e) => !excluded.has(e.name))
            .map((e) => ({ entry: sbsManifestItemToRenderItem(e), label: f.label }));
        } catch (e) {
          return [];
        }
      })
    );

    // Pull priority photos out first, by filename, in the order specified
    // above — regardless of which category each one actually lives in —
    // and remove them from their category's list so the interleave below
    // doesn't also place them a second time.
    const priorityItems = [];
    SBS_HOMEPAGE_PRIORITY.forEach((name) => {
      for (const list of perFolder) {
        const idx = list.findIndex((it) => it.entry.name === name);
        if (idx !== -1) {
          priorityItems.push(list.splice(idx, 1)[0]);
          break;
        }
      }
    });

    const merged = [...priorityItems];
    const maxLen = Math.max(0, ...perFolder.map((r) => r.length));
    for (let i = 0; i < maxLen; i++) {
      perFolder.forEach((r) => {
        if (r[i]) merged.push(r[i]);
      });
    }

    container.classList.remove("is-loading");

    if (!merged.length) {
      container.innerHTML = `<div class="gallery-empty">No photos yet — add images to the photos/ folders on GitHub and they'll appear here automatically.</div>`;
      return;
    }

    sbsRenderCards(container, merged);
  } catch (err) {
    container.classList.remove("is-loading");
    container.innerHTML = `<div class="gallery-error">Couldn't load photos right now (${err.message}).</div>`;
  }
}

/* Client galleries hub — reads manifests/clients/index.json, one entry
   per client shoot folder */
async function sbsLoadClientHub(containerId, basePath) {
  const container = document.getElementById(containerId);
  if (!container) return;

  try {
    const index = await sbsLoadManifest("manifests/clients/index.json");

 //   if (!index.length) {
 //     container.innerHTML = `<div class="client-empty">No client galleries yet.<br>Create a folder inside <code>${basePath}/</code> on GitHub — one per shoot — drop the photos in, and it'll show up here automatically after thumbnails finish generating.</div>`;
 //    return;
 //   }


    if (!index.length) {
      container.innerHTML = `<div class="client-empty">As more clients purchase photos, Their purchased photos will show up here automatically.</div>`;
      return;
    }

    container.innerHTML = "";
    index.forEach((c) => {
      const a = document.createElement("a");
      a.className = "client-card";
      a.href = `gallery.html?event=${encodeURIComponent(c.slug)}`;

      const thumb = document.createElement("div");
      thumb.className = `thumb${c.cover ? "" : " is-empty"}`;
      if (c.cover) {
        const img = document.createElement("img");
        img.src = sbsRawUrl(c.cover);
        img.alt = `${sbsFormatLabel(c.slug)} cover photo`;
        img.loading = "lazy";
        thumb.appendChild(img);
      } else {
        thumb.textContent = "—";
      }

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = `<div class="name">${sbsFormatLabel(c.slug)}</div><div class="count">${c.count} photo${c.count === 1 ? "" : "s"}</div>`;

      a.appendChild(thumb);
      a.appendChild(meta);
      container.appendChild(a);
    });
  } catch (err) {
    container.innerHTML = `<div class="gallery-error">Couldn't load client galleries right now (${err.message}).</div>`;
  }
}

/* Single client gallery detail — photos/clients/<slug>/ */
async function sbsLoadClientDetail(containerId, headingId, basePath) {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get("event");
  const heading = document.getElementById(headingId);

  if (!slug) {
    if (heading) heading.textContent = "Client galleries";
    return { slug: null };
  }

  const label = sbsFormatLabel(slug);
  if (heading) heading.textContent = label;
  document.title = `${label} | ShotsBySkaza`;

  await sbsLoadGallery(containerId, `${basePath}/${slug}`, label);
  return { slug, label };
}
