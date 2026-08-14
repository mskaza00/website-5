/* =============================================================
   ShotsBySkaza — photo loader
   Reads pre-generated manifest files (see /manifests) for the photo
   list, dimensions, thumbnail path, and watermarked display path for
   each category. Manifests + watermarked WebP images are generated
   automatically by a GitHub Action (.github/workflows/generate-manifests.yml)
   every time photos are added or removed — nothing to run by hand.

   HOW IT WORKS
   - manifests/<category>.json lists every photo in that category.
   - manifests/clients/index.json lists every client gallery folder.
   - The gallery displays each photo's small watermarked WebP thumbnail.
     The lightbox (see main.js) opens the larger watermarked "display"
     version — not the true original — when a photo is clicked. Both
     have the logo baked into the pixel data (not a CSS overlay), so a
     saved/screenshotted copy keeps the watermark.
   - A photo's real width/height (from the manifest) is used to place it
     into whichever masonry column is currently shortest — true masonry,
     no cropping, no reordering after placement.
   - Thumbnails are lazy: an <img> only gets a real src once it's near
     the viewport (see sbsLazyLoadObserver below).

   IF A MANIFEST IS MISSING
   That just means the Action hasn't generated it yet for that folder —
   the affected gallery shows its normal "no photos yet" empty state
   rather than an error. It resolves itself on the next push.
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

const SBS_CACHE_TTL_MS = 2 * 60 * 1000;

const SBS_JSON_CACHE = new Map();

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

/* Converts a manifest entry into what the renderer needs. fullUrl now
   points at the watermarked "display" version, NOT the true original —
   that's the fix for watermarks surviving a save/screenshot. */
function sbsManifestItemToRenderItem(entry) {
  return {
    name: entry.name,
    width: entry.width,
    height: entry.height,
    thumbUrl: sbsRawUrl(entry.thumb || entry.display || entry.src),
    fullUrl: sbsRawUrl(entry.display || entry.src),
  };
}

function sbsRenderPhotoCard(item, label) {
  const card = document.createElement("a");
  card.href = item.fullUrl;
  card.className = "photo-card";
  card.target = "_blank";
  card.rel = "noopener";
  card.dataset.full = item.fullUrl;
  card.dataset.caption = label ? `${label} — ${item.name}` : item.name;

  if (item.width && item.height) {
    card.style.aspectRatio = `${item.width} / ${item.height}`;
  }

  const img = document.createElement("img");
  img.dataset.src = item.thumbUrl;
  img.alt = label
    ? `${label} photography by Matthew Skaza (ShotsBySkaza), Western Massachusetts`
    : "Photography by Matthew Skaza (ShotsBySkaza), Western Massachusetts";
  card.appendChild(img);

  const a = document.createElement("span");
  a.className = "corner-a";
  const b = document.createElement("span");
  b.className = "corner-b";
  card.appendChild(a);
  card.appendChild(b);

  return card;
}

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

  const REF_WIDTH = 300;
  const cards = entries.map((entryWrapper, i) => {
    const item = entryWrapper.entry || entryWrapper;
    const itemLabel = entryWrapper.label !== undefined ? entryWrapper.label : label;
    const card = sbsRenderPhotoCard(item, itemLabel);

    const estHeight = item.width && item.height ? (item.height / item.width) * REF_WIDTH : REF_WIDTH;

    let targetCol;
    if (i < priorityCount) {
      targetCol = i % count;
    } else {
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

function sbsPromptPassword(clientEntry) {
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
