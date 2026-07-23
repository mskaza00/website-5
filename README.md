# ShotsBySkaza

Sports, portrait, and event photography site for Matthew Skaza. Plain HTML/CSS/JS,
no build step, no framework — hosted for free on GitHub Pages.

## Turning this repo into a live website

The site isn't live yet — right now this is just a repo, not a published page. To fix that:

1. Go to the repo on GitHub → **Settings** → **Pages** (left sidebar).
2. Under "Build and deployment" → **Source**, choose **Deploy from a branch**.
3. Branch: `main`, folder: `/ (root)`. Save.
4. Wait a minute, then your site is live at:
   `https://mskaza00.github.io/shotsbyskaza-website/`

That's your real site URL until you own `shotsbyskaza.com`. Once you buy the domain
(Namecheap, Google Domains successor, GoDaddy, etc.), come back to this README for
the last step below.

## Adding and removing photos

No code editing needed. Each page reads its photos straight from a folder in this
repo, live, every time someone visits:

| Page | Reads from |
|---|---|
| Sports | `photos/sports/` |
| Portraits | `photos/portraits/` |
| Events | `photos/events/` |
| Homepage | all three of the above, mixed together |

To add a photo: upload the image file into the right folder (GitHub web UI: open the
folder → **Add file** → **Upload files**). To remove one: delete it from the folder.
The site picks it up automatically — nothing else to touch.

A few things worth knowing:

- **Supported formats:** `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.avif`. Anything
  else in the folder is ignored.
- **Order:** photos display in alphabetical order by filename (GitHub doesn't expose
  upload date). If you want control over the order, rename files with a number
  prefix, e.g. `01-touchdown.jpg`, `02-huddle.jpg`.
- **File size — please compress before uploading.** Straight-off-the-camera files
  in this repo are currently 5–20MB each. That's fine for editing, but on a live
  site it means every visitor waits a long time for a page to load. Before
  uploading, resize the long edge to around 2000px and compress — free tools like
  squoosh.app work well, or Lightroom's export at ~80% quality. Aim for roughly
  200–500KB per photo.
- The repo currently has two photos sitting loose in the root folder
  (`_F2A2314.jpg`, `_F2A6298.jpg`) that aren't inside any category folder, so they
  won't show up anywhere on the site. Move them into `photos/sports/` or wherever
  they belong if you want them to appear, or delete them if not.

## Client galleries

This is for delivering photos to a specific client/team after a shoot — e.g. 20
photos from a Chicopee basketball game that only that team needs.

To create one:

1. In `photos/clients/`, create a new folder — one per shoot. Use a short
   dash-separated name, e.g. `chicopee-basketball-jan-2026`.
2. Upload that shoot's photos into it.
3. Send the client this link:
   `https://mskaza00.github.io/shotsbyskaza-website/gallery.html?event=chicopee-basketball-jan-2026`
   (swap in your folder name after `?event=`).

The **Client Galleries** page also automatically lists every folder you create
under `photos/clients/` as its own card, so people can browse to find their
gallery even without the direct link.

Note: anyone with the link can view that gallery — there's no password on it. That's
usually fine for handing off proofs, just don't rely on it for anything that needs
to stay private.

## Once you own shotsbyskaza.com

All links on the site are relative (`portraits.html`, not a hardcoded domain), so
nothing in the code needs to change. Just:

1. In the repo root, add a file named exactly `CNAME` (no extension) containing:
   ```
   shotsbyskaza.com
   ```
2. At your domain registrar's DNS settings, add four **A** records for the apex
   domain (`shotsbyskaza.com`) pointing to:
   ```
   185.199.108.153
   185.199.109.153
   185.199.110.153
   185.199.111.153
   ```
   and a **CNAME** record for `www` pointing to `mskaza00.github.io`.
3. Back in repo **Settings → Pages**, enter `shotsbyskaza.com` under "Custom domain"
   and save. DNS changes can take up to a day to fully take effect.

## Brand

Primary accent color: `#4557f3`. Defined once as `--brand` at the top of
`css/style.css` — change it there and it updates everywhere.

## File structure

```
index.html          Homepage — hero, combined portfolio, About, footer
sports.html          Sports-only portfolio page
portraits.html       Portraits-only portfolio page
events.html          Events-only portfolio page
gallery.html         Client Galleries hub + individual client gallery view
css/style.css        All styles
js/main.js           Header behavior, nav, lightbox
js/gallery-loader.js Pulls photos live from the folders above via GitHub's API
photos/sports/       Sports photos
photos/portraits/    Portrait photos
photos/events/       Event photos
photos/clients/      One subfolder per client shoot
```
