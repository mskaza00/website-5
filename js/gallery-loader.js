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
const SBS_REPO_NAME = "website-4-";

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
  img.src = entry.download_url;
  img.alt = label ? `${label} photo by Shots By Skaza` : "Photo by Shots By Skaza";
  img.loading = "lazy";
  card.appendChild(img);

  const a = document.createElement("span");
  a.className = "corner-a";
  const b = document.createElement("span");
  b.className = "corner-b";
  card.appendChild(a);
  card.appendChild(b);

  return card;
}

function sbsFinishContainer(container) {
  window.SBS_observeCards && window.SBS_observeCards(container);
  window.SBS_registerLightboxGroup && window.SBS_registerLightboxGroup(container);
}

/* Single category (Portraits / Sports / Events pages) */
async function sbsLoadGallery(containerId, folderPath, label) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.classList.add("is-loading");

  try {
    const entries = await sbsFetchFolder(folderPath);
    const images = entries.filter(sbsIsImage).sort((a, b) => a.name.localeCompare(b.name));
    container.classList.remove("is-loading");

    if (!images.length) {
      container.innerHTML = `<div class="gallery-empty">No photos here yet. Drop images into <code>${folderPath}/</code> on GitHub and they'll show up automatically.</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    images.forEach((entry) => frag.appendChild(sbsRenderPhotoCard(entry, label)));
    container.appendChild(frag);
    sbsFinishContainer(container);
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
    const perFolder = await Promise.all(
      folders.map((f) =>
        sbsFetchFolder(f.path)
          .then((entries) =>
            entries
              .filter(sbsIsImage)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((e) => ({ entry: e, label: f.label }))
          )
          .catch(() => [])
      )
    );

    const merged = [];
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

    const frag = document.createDocumentFragment();
    merged.forEach((item) => frag.appendChild(sbsRenderPhotoCard(item.entry, item.label)));
    container.appendChild(frag);
    sbsFinishContainer(container);
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
