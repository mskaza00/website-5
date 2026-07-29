/* =============================================================
   ShotsBySkaza — photo loader
   Reads folders directly from the GitHub repo via the GitHub
   Contents API, so photos update just by adding/removing files
   in photos/ on GitHub — no code changes needed.

   HOW IT WORKS
   - Each page asks for one or more folder paths (e.g. "photos/sports").
   - We call the public GitHub API for that folder's file listing.
   - Every image file found gets rendered into the page, at its
     natural aspect ratio, in a CSS-masonry grid.

   LIMITS TO KNOW ABOUT
   - This only works for a PUBLIC repo (this one is).
   - GitHub's API allows ~60 unauthenticated requests/hour per
     visitor's IP. Fine for normal browsing; if a page ever shows
     a load error, that's almost certainly why — it resets hourly.
   - Photos are listed alphabetically by filename (GitHub doesn't
     expose upload date), so name files like 01-xxx.jpg, 02-xxx.jpg
     if you care about the order they appear in.
   ============================================================= */

const SBS_REPO_OWNER = "mskaza00";
const SBS_REPO_NAME = "website-5";

const SBS_IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;

function sbsIsImage(entry) {
  return entry.type === "file" && SBS_IMAGE_EXT.test(entry.name);
}

function sbsFormatLabel(slug) {
  return slug
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// How long a folder listing is trusted before we ask GitHub again. Short enough
// that newly-added/removed photos show up on a normal refresh; long enough to
// avoid re-fetching every folder on every single click while browsing around.
const SBS_CACHE_TTL_MS = 2 * 60 * 1000;

async function sbsFetchFolder(path) {
  const cacheKey = `sbs-cache:${path}`;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed.t === "number" && Date.now() - parsed.t < SBS_CACHE_TTL_MS) {
        return parsed.data;
      }
    }
  } catch (e) {
    /* sessionStorage unavailable or corrupt — skip caching */
  }

  const url = `https://api.github.com/repos/${SBS_REPO_OWNER}/${SBS_REPO_NAME}/contents/${path}`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });

  if (res.status === 404) return []; // folder doesn't exist yet — treat as empty, not an error
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);

  const data = await res.json();
  const list = Array.isArray(data) ? data : [];
  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), data: list }));
  } catch (e) {
    /* quota exceeded or unavailable — fine, just skip caching */
  }
  return list;
}

function sbsRenderPhotoCard(entry, label) {
  const card = document.createElement("a");
  card.href = entry.download_url;
  card.className = "photo-card";
  card.target = "_blank";
  card.rel = "noopener";
  card.dataset.full = entry.download_url;
  card.dataset.caption = label ? `${label} — ${entry.name}` : entry.name;

  const img = document.createElement("img");
  img.dataset.src = entry.download_url; // real src assigned by sbsLazyLoadObserver below
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

/* Only assigns the real src once an image is genuinely near the viewport.
   Works safely with the JS-built columns below because each column is
   plain block flow — no global layout/balance step exists that could be
   thrown off by images resolving their height at different times. */
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
  { rootMargin: "600px 0px" }
);

function sbsFinishContainer(container) {
  window.SBS_observeCards && window.SBS_observeCards(container);
  window.SBS_registerLightboxGroup && window.SBS_registerLightboxGroup(container);
}

/* ---------------- Photo dimension manifests ----------------
   Each photos/<folder>/manifest.json lists every photo's real width and
   height, generated ahead of time by scripts/generate-manifest.js (see
   the accompanying GitHub Action, which runs it automatically on every
   push touching photos/). One small JSON fetch per folder gives us every
   dimension needed for true masonry — no per-photo network requests. */

const SBS_MANIFEST_CACHE = new Map();

async function sbsLoadManifest(folderPath) {
  if (SBS_MANIFEST_CACHE.has(folderPath)) return SBS_MANIFEST_CACHE.get(folderPath);

  const map = new Map();
  const cacheKey = `sbs-cache:${folderPath}/manifest.json`;

  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed.t === "number" && Date.now() - parsed.t < SBS_CACHE_TTL_MS) {
        parsed.data.forEach((item) => map.set(item.name, item));
        SBS_MANIFEST_CACHE.set(folderPath, map);
        return map;
      }
    }
  } catch (e) {
    /* skip cache on error */
  }

  try {
    const url = `https://raw.githubusercontent.com/${SBS_REPO_OWNER}/${SBS_REPO_NAME}/main/${folderPath}/manifest.json`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      data.forEach((item) => map.set(item.name, item));
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), data }));
      } catch (e) {
        /* skip cache on error */
      }
    }
    // A missing manifest (404) just means this folder hasn't been scanned
    // yet — not an error. Affected photos fall back to a default size
    // guess in sbsRenderCards until the manifest catches up.
  } catch (e) {
    /* network error — same graceful fallback as above */
  }

  SBS_MANIFEST_CACHE.set(folderPath, map);
  return map;
}

/* ---------------- JS-built masonry columns ----------------
   Each photo's real (manifest-supplied) height determines which column
   it's assigned to — always the currently shortest one, exactly like
   traditional Pinterest-style masonry. Assignment happens once, up
   front, before any full-resolution image has loaded, so a photo can
   never later jump to a different column or shuffle another photo's
   position — only the column it's already in can grow. */

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
  const cards = entries.map((item) => {
    const entry = item.entry || item;
    const itemLabel = item.label !== undefined ? item.label : label;
    const card = sbsRenderPhotoCard(entry, itemLabel);

    const estHeight =
      entry.width && entry.height ? (entry.height / entry.width) * REF_WIDTH : REF_WIDTH;

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
    const url = `https://raw.githubusercontent.com/${SBS_REPO_OWNER}/${SBS_REPO_NAME}/main/homepage-exclude.txt`;
    const res = await fetch(url);
    if (!res.ok) {
      SBS_EXCLUDE_CACHE = new Set();
      return SBS_EXCLUDE_CACHE;
    }
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
  } catch (e) {
    SBS_EXCLUDE_CACHE = new Set();
  }

  return SBS_EXCLUDE_CACHE;
}

/* Single category (Portraits / Sports / Events pages) */
async function sbsLoadGallery(containerId, folderPath, label) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.classList.add("is-loading");

  try {
    const [entries, manifest] = await Promise.all([
      sbsFetchFolder(folderPath),
      sbsLoadManifest(folderPath),
    ]);
    const images = entries
      .filter(sbsIsImage)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => {
        const dims = manifest.get(e.name);
        return dims ? { ...e, width: dims.width, height: dims.height } : e;
      });

    if (!images.length) {
      container.classList.remove("is-loading");
      container.innerHTML = `<div class="gallery-empty">No photos here yet. Drop images into <code>${folderPath}/</code> on GitHub and they'll show up automatically.</div>`;
      return;
    }

    sbsRenderCards(container, images, label);
    container.classList.remove("is-loading");
  } catch (err) {
    container.classList.remove("is-loading");
    container.innerHTML = `<div class="gallery-error">Couldn't load photos right now (${err.message}). If this keeps happening, GitHub's free API limit may have been hit — it resets within the hour.</div>`;
  }
}

/* Combined homepage feed — merges several folders, interleaved */
async function sbsLoadCombinedGallery(containerId, folders) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.classList.add("is-loading");

  try {
    const excluded = await sbsLoadExcludeList();

    const perFolder = await Promise.all(
      folders.map(async (f) => {
        try {
          const [entries, manifest] = await Promise.all([
            sbsFetchFolder(f.path),
            sbsLoadManifest(f.path),
          ]);
          return entries
            .filter(sbsIsImage)
            .filter((e) => !excluded.has(e.name))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((e) => {
              const dims = manifest.get(e.name);
              const withDims = dims ? { ...e, width: dims.width, height: dims.height } : e;
              return { entry: withDims, label: f.label };
            });
        } catch (e) {
          return [];
        }
      })
    );

    const merged = [];
    const maxLen = Math.max(0, ...perFolder.map((r) => r.length));
    for (let i = 0; i < maxLen; i++) {
      perFolder.forEach((r) => {
        if (r[i]) merged.push(r[i]);
      });
    }

    if (!merged.length) {
      container.classList.remove("is-loading");
      container.innerHTML = `<div class="gallery-empty">No photos yet — add images to the photos/ folders on GitHub and they'll appear here automatically.</div>`;
      return;
    }

    sbsRenderCards(container, merged);
    container.classList.remove("is-loading");
  } catch (err) {
    container.classList.remove("is-loading");
    container.innerHTML = `<div class="gallery-error">Couldn't load photos right now (${err.message}).</div>`;
  }
}

/* Client galleries hub — lists every subfolder of photos/clients/ as a card */
async function sbsLoadClientHub(containerId, basePath) {
  const container = document.getElementById(containerId);
  if (!container) return;

  try {
    const entries = await sbsFetchFolder(basePath);
    const folders = entries.filter((e) => e.type === "dir");

    if (!folders.length) {
      container.innerHTML = `<div class="client-empty">No client galleries yet.<br>Create a folder inside <code>${basePath}/</code> on GitHub — one per shoot — drop the photos in, and it'll show up here automatically.</div>`;
      return;
    }

    const cards = await Promise.all(
      folders.map(async (f) => {
        let cover = null;
        let count = 0;
        try {
          const inner = await sbsFetchFolder(`${basePath}/${f.name}`);
          const images = inner.filter(sbsIsImage);
          count = images.length;
          cover = images[0] || null;
        } catch (e) {
          /* leave as empty cover */
        }
        return { slug: f.name, cover, count };
      })
    );

    container.innerHTML = "";
    cards.forEach((c) => {
      const a = document.createElement("a");
      a.className = "client-card";
      a.href = `gallery.html?event=${encodeURIComponent(c.slug)}`;

      const thumb = document.createElement("div");
      thumb.className = `thumb${c.cover ? "" : " is-empty"}`;
      if (c.cover) {
        const img = document.createElement("img");
        img.src = c.cover.download_url;
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
