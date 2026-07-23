/* =============================================================
   ShotsBySkaza — shared site behavior
   Header scroll fade, mobile nav, dropdown, scroll reveal, lightbox.
   Loaded on every page.
   ============================================================= */

(function header() {
  const header = document.querySelector(".site-header");
  if (!header) return;

  // Background fades from solid to fully transparent over this many px of scroll.
  const FADE_RANGE = 320;
  let ticking = false;

  function update() {
    const y = window.scrollY || window.pageYOffset;
    const alpha = Math.max(0, 1 - y / FADE_RANGE);
    header.style.setProperty("--header-alpha", alpha.toFixed(3));
    header.classList.toggle("is-scrolled", y > 4);
    ticking = false;
  }

  window.addEventListener(
    "scroll",
    () => {
      if (!ticking) {
        requestAnimationFrame(update);
        ticking = true;
      }
    },
    { passive: true }
  );

  update();
})();

(function mobileNav() {
  const toggle = document.getElementById("navToggle");
  const nav = document.getElementById("siteNav");
  if (!toggle || !nav) return;

  toggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(isOpen));
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
})();

(function dropdown() {
  document.querySelectorAll(".dropdown-trigger").forEach((trigger) => {
    trigger.addEventListener("click", (e) => {
      // Desktop relies on :hover / :focus-within — this click handler is only
      // needed so the menu is reachable by tap on touch devices.
      if (window.innerWidth <= 900) {
        e.preventDefault();
        const dropdown = trigger.closest(".dropdown");
        const isOpen = dropdown.classList.toggle("is-open");
        trigger.setAttribute("aria-expanded", String(isOpen));
      }
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".dropdown")) {
      document.querySelectorAll(".dropdown.is-open").forEach((d) => {
        d.classList.remove("is-open");
        d.querySelector(".dropdown-trigger")?.setAttribute("aria-expanded", "false");
      });
    }
  });
})();

/* ---------------- Scroll reveal for gallery cards ---------------- */

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.08, rootMargin: "0px 0px -40px 0px" }
);

// Called by gallery-loader.js after it appends new cards to a container.
window.SBS_observeCards = function observeCards(container) {
  container.querySelectorAll(".photo-card:not(.is-visible)").forEach((card) => {
    revealObserver.observe(card);
  });
};

/* ---------------- Lightbox ---------------- */

(function lightbox() {
  const lightbox = document.getElementById("lightbox");
  if (!lightbox) return;

  const img = document.getElementById("lightboxImg");
  const caption = document.getElementById("lightboxCaption");
  const closeBtn = document.getElementById("lightboxClose");
  const prevBtn = document.getElementById("lightboxPrev");
  const nextBtn = document.getElementById("lightboxNext");

  let groups = []; // each group is the live list of .photo-card elements in one container
  let activeGroup = [];
  let index = 0;

  // Called by gallery-loader.js once a container's cards are rendered.
  window.SBS_registerLightboxGroup = function registerGroup(container) {
    groups.push(container);
  };

  function cardsFor(container) {
    return Array.from(container.querySelectorAll(".photo-card"));
  }

  function openFrom(container, clickedCard) {
    activeGroup = cardsFor(container);
    index = activeGroup.indexOf(clickedCard);
    if (index === -1) index = 0;
    show();
    lightbox.classList.add("is-open");
    lightbox.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function close() {
    lightbox.classList.remove("is-open");
    lightbox.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  function show() {
    const card = activeGroup[index];
    if (!card) return;
    img.src = card.dataset.full || card.querySelector("img").src;
    img.alt = card.dataset.caption || "";
    caption.textContent = card.dataset.caption || "";
  }

  function step(delta) {
    if (!activeGroup.length) return;
    index = (index + delta + activeGroup.length) % activeGroup.length;
    show();
  }

  document.addEventListener("click", (e) => {
    const card = e.target.closest(".photo-card");
    if (!card) return;
    const container = groups.find((g) => g.contains(card));
    if (!container) return;
    e.preventDefault();
    openFrom(container, card);
  });

  closeBtn.addEventListener("click", close);
  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));

  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) close();
  });

  document.addEventListener("keydown", (e) => {
    if (!lightbox.classList.contains("is-open")) return;
    if (e.key === "Escape") close();
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });
})();
