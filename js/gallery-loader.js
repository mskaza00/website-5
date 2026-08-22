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

   ANTI-SAVE DETERRENTS (see sbsInitAntiSave below)
   These are UX friction, not real protection — the OS screenshot
   shortcut and screen recording bypass all of them. They stop the
   casual right-click / long-press / drag-and-drop save and blur the
   gallery during an app-switch or screen recording so a passive capture
   is less useful. They do NOT stop a deliberate screenshot, and they do
   NOT replace watermarking the actual served image files.
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
   needs (full raw URLs, ready to use as src/href).
   NOTE: fullUrl currently points at entry.src — the true original file,
   not a watermarked/downsized "display" copy. Anti-save deterrents below
   only add friction around the UI; they do nothing to protect this URL
   itself once someone has it (view-source, DevTools, "Open image in new
   tab", etc. all still work). */
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
  img.alt = label
    ? `${label} photography by Matthew Skaza (ShotsBySkaza), Western Massachusetts`
    : "Photography by Matthew Skaza (ShotsBySkaza), Western Massachusetts";
  // Anti-save deterrents (see sbsInitAntiSave): block the browser's
  // built-in "save image" / "copy image" affordances on the <img> itself.
  img.draggable = false;
  img.oncontextmenu = () => false;
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

/* ---------------- Anti-save deterrents ----------------
   Best-effort friction only — see the note at the top of this file.
   Initialized once, globally, on first script load. */
let sbsAntiSaveInitialized = false;

function sbsInitAntiSave() {
  if (sbsAntiSaveInitialized) return;
  sbsAntiSaveInitialized = true;

  // Block right-click / long-press context menu anywhere inside a photo
  // card (covers "Save Image As", "Copy Image", "Open Image in New Tab").
  // Delegated at the document level so it also covers cards rendered
  // after this runs (masonry rebuilds on resize, later galleries, etc).
  document.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".photo-card")) e.preventDefault();
  });

  // Block drag-and-drop of the image out of the browser window (a common
  // way to save an image without going through a menu at all).
  document.addEventListener("dragstart", (e) => {
    if (e.target.closest(".photo-card")) e.preventDefault();
  });

  // Blur galleries while the tab is hidden/backgrounded — covers the
  // window between starting a screen recording (which backgrounds most
  // browsers momentarily) or switching apps mid-capture. Does nothing
  // against a direct screenshot taken while the tab stays foregrounded.
  document.addEventListener("visibilitychange", () => {
    document.querySelectorAll(".masonry").forEach((el) => {
      el.style.filter = document.hidden ? "blur(24px)" : "";
      el.style.transition = "filter 0.15s ease";
    });
  });

  // Prevent "Print to PDF" as a save method.
  const style = document.createElement("style");
  style.textContent = "@media print { .masonry, .photo-card { display: none !important; } }";
  document.head.appendChild(style);
}

sbsInitAntiSave();

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

function sbsRenderCards(container, entries, label, priorityCount) {
  priorityCount = priorityCount || 0;
  const count = sbsGetColumnCount();
  const cols = sbsBuildColumns(container, count);
  const colHeights = new Array(count).fill(0);

  const REF_WIDTH = 300; // arbitrary reference width — only used to compare relative heights
  const cards = entries.map((entryWrapper, i) => {
    const item = entryWrapper.entry || entryWrapper;
    const itemLabel = entryWrapper.label !== undefined ? entryWrapper.label : label;
    const card = sbsRenderPhotoCard(item, itemLabel);

    const estHeight = item.width && item.height ? (item.height / item.width) * REF_WIDTH : REF_WIDTH;

    let targetCol;
    if (i < priorityCount) {
      // Priority set: left-to-right, in order, one per column, then cycle —
      // never reordered by height, so these visibly lead the gallery.
      targetCol = i % count;
    } else {
      // Everyone else: existing shortest-column masonry, continuing on top
      // of whatever height the priority photos already added.
      targetCol = 0;
      for (let c = 1; c < count; c++) {
        if (colHeights[c] < colHeights[targetCol]) targetCol = c;
      }
    }

    cols[targetCol].appendChild(card);
    colHeights[targetCol] += estHeight;

    return card;
  });

  cards.forEach((card) => {
    const img = card.querySelector("img");
    if (img) sbsLazyLoadObserver.observe(img);
  });

  container.dataset.sbsColumns = String(count);
  container._sbsEntries = entries;
  container._sbsLabel = label;
  container._sbsPriorityCount = priorityCount;

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
      sbsRenderCards(container, container._sbsEntries, container._sbsLabel, container._sbsPriorityCount);
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

    sbsRenderCards(container, merged, undefined, priorityItems.length);
  } catch (err) {
    container.classList.remove("is-loading");
    container.innerHTML = `<div class="gallery-error">Couldn't load photos right now (${err.message}).</div>`;
  }
}

function sbsFormatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

async function sbsSha256(text) {
  const enc = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* Once a client gallery's password is entered correctly, remember that
   for the rest of the browser session (sessionStorage — cleared when the
   tab/browser closes, but survives page navigations and reloads within
   it). Keyed by slug + the gallery's current passwordHash, so changing a
   gallery's password automatically invalidates any old unlock. */
function sbsUnlockKey(clientEntry) {
  return `sbs-unlocked:${clientEntry.slug}:${clientEntry.passwordHash}`;
}

function sbsIsUnlocked(clientEntry) {
  try {
    return sessionStorage.getItem(sbsUnlockKey(clientEntry)) === "1";
  } catch (e) {
    return false;
  }
}

function sbsMarkUnlocked(clientEntry) {
  try {
    sessionStorage.setItem(sbsUnlockKey(clientEntry), "1");
  } catch (e) {
    /* skip on storage error (e.g. private browsing quota) */
  }
}

/* Shows the password modal (markup lives in gallery.html) for a locked
   client entry. Resolves true if the correct password was entered (or
   was already unlocked earlier this session), false if the visitor
   cancels. A correct entry is remembered for the rest of the browser
   session via sbsMarkUnlocked, so the same gallery won't prompt again
   until the tab/browser is closed. */
function sbsPromptPassword(clientEntry) {
  if (sbsIsUnlocked(clientEntry)) return Promise.resolve(true);

  return new Promise((resolve) => {
    const modal = document.getElementById("passwordModal");
    const input = document.getElementById("passwordInput");
    const form = document.getElementById("passwordForm");
    const errorEl = document.getElementById("passwordError");
    const titleEl = document.getElementById("passwordModalTitle");
    const cancelBtn = document.getElementById("passwordCancel");

    if (!modal || !input || !form || !cancelBtn) {
      resolve(false);
      return;
    }

    const label = clientEntry.title || sbsFormatLabel(clientEntry.slug);
    if (titleEl) titleEl.textContent = `Enter password for "${label}"`;
    if (errorEl) errorEl.textContent = "";
    input.value = "";
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    input.focus();

    function cleanup(result) {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      form.removeEventListener("submit", onSubmit);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }

    async function onSubmit(e) {
      e.preventDefault();
      const hash = await sbsSha256(input.value);
      if (hash === clientEntry.passwordHash) {
        sbsMarkUnlocked(clientEntry);
        cleanup(true);
      } else {
        if (errorEl) errorEl.textContent = "Incorrect password — try again.";
        input.value = "";
        input.focus();
      }
    }

    function onCancel() {
      cleanup(false);
    }

    form.addEventListener("submit", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
  });
}

/* Client galleries hub — reads manifests/clients/index.json, one entry
   per client shoot folder. Supports a search box (#clientSearch) and a
   sort dropdown (#clientSort) if present in the page markup. */
async function sbsLoadClientHub(containerId, basePath) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const searchInput = document.getElementById("clientSearch");
  const sortSelect = document.getElementById("clientSort");

  try {
    const index = await sbsLoadManifest("manifests/clients/index.json");

    if (!index.length) {
      container.innerHTML = `<div class="client-empty">No client galleries yet.<br>Create a folder inside <code>${basePath}/</code> on GitHub — one per shoot — drop the photos in, and it'll show up here automatically after thumbnails finish generating.</div>`;
      return;
    }

    function render() {
      const query = (searchInput && searchInput.value ? searchInput.value : "").trim().toLowerCase();
      const sortBy = sortSelect && sortSelect.value ? sortSelect.value : "newest";

      let list = index.filter((c) => (c.title || sbsFormatLabel(c.slug)).toLowerCase().includes(query));

      list = list.slice().sort((a, b) => {
        const titleA = a.title || sbsFormatLabel(a.slug);
        const titleB = b.title || sbsFormatLabel(b.slug);
        if (sortBy === "name") return titleA.localeCompare(titleB);
        const dateA = a.date ? new Date(a.date).getTime() : 0;
        const dateB = b.date ? new Date(b.date).getTime() : 0;
        return sortBy === "oldest" ? dateA - dateB : dateB - dateA;
      });

      container.innerHTML = "";

      if (!list.length) {
        container.innerHTML = `<div class="client-empty">No galleries match "${query}".</div>`;
        return;
      }

      list.forEach((c) => {
        const title = c.title || sbsFormatLabel(c.slug);
        const a = document.createElement("a");
        a.className = "client-card";
        a.href = `gallery.html?event=${encodeURIComponent(c.slug)}`;

        const thumb = document.createElement("div");
        thumb.className = `thumb${c.cover ? "" : " is-empty"}`;
        if (c.cover) {
          const img = document.createElement("img");
          img.src = sbsRawUrl(c.cover);
          img.alt = `${title} cover photo`;
          img.loading = "lazy";
          thumb.appendChild(img);
        } else {
          thumb.textContent = "—";
        }
        if (c.locked) {
          const lock = document.createElement("span");
          lock.className = "client-lock";
          lock.setAttribute("aria-label", "Password protected");
          lock.textContent = "🔒";
          thumb.appendChild(lock);
        }

        const meta = document.createElement("div");
        meta.className = "meta";
        const dateHtml = c.date ? `<div class="date">${sbsFormatDate(c.date)}</div>` : "";
        meta.innerHTML = `<div class="name">${title}</div>${dateHtml}<div class="count">${c.count} photo${c.count === 1 ? "" : "s"}</div>`;

        a.appendChild(thumb);
        a.appendChild(meta);

        if (c.locked) {
          a.addEventListener("click", (e) => {
            e.preventDefault();
            sbsPromptPassword(c).then((ok) => {
              if (ok) window.location.href = a.href;
            });
          });
        }

        container.appendChild(a);
      });
    }

    render();
    if (searchInput) searchInput.addEventListener("input", render);
    if (sortSelect) sortSelect.addEventListener("change", render);
  } catch (err) {
    container.innerHTML = `<div class="gallery-error">Couldn't load client galleries right now (${err.message}).</div>`;
  }
}

/* Single client gallery detail — photos/clients/<slug>/. Locked galleries
   are gated here too (not just on the hub card), so a direct link can't
   skip the password prompt. */
async function sbsLoadClientDetail(containerId, headingId, basePath) {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get("event");
  const heading = document.getElementById(headingId);
  const container = document.getElementById(containerId);

  if (!slug) {
    if (heading) heading.textContent = "Client galleries";
    return { slug: null };
  }

  const index = await sbsLoadManifest("manifests/clients/index.json");
  const entry = index.find((c) => c.slug === slug);

  if (entry && entry.locked) {
    const ok = await sbsPromptPassword(entry);
    if (!ok) {
      if (heading) heading.textContent = "Locked gallery";
      if (container) {
        container.hidden = false;
        container.innerHTML = `<div class="gallery-empty">This gallery is password protected. <a href="gallery.html">← Back to client galleries</a></div>`;
      }
      return { slug, locked: true };
    }
  }

  const label = (entry && entry.title) || sbsFormatLabel(slug);
  if (heading) heading.textContent = label;
  document.title = `${label} | ShotsBySkaza`;

  await sbsLoadGallery(containerId, `${basePath}/${slug}`, label);
  return { slug, label };
}
