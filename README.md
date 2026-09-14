# ImageToPDF Pro

A fast, privacy-first **image to PDF converter** that runs entirely in the browser, built as a static site for **GitHub Pages** and ready for **Google AdSense**.

- Converts JPG, PNG, HEIC/HEIF, WebP, GIF, BMP, AVIF and SVG to PDF. Nothing is uploaded.
- JPEGs are embedded byte-for-byte (no quality loss). Other formats are stored losslessly, with optional compression presets.
- Drag-and-drop ordering (mouse and touch), rotation, sorting, page size (A4, Letter, Legal, A3, A5, or image size), orientation, margins, fit/fill, one PDF or a ZIP of separate PDFs.
- Honors EXIF orientation, reads iPhone HEIC photos in any browser, and supports clipboard paste.
- Installable PWA: works offline, accepts images from the Android share sheet, and can open image files from the desktop.
- SEO: canonical URLs, Open Graph/Twitter cards, JSON-LD (WebApplication, Article, FAQPage, BreadcrumbList), sitemap, robots.txt.
- Accessible: follows WCAG 2.2 AA practices, with keyboard reordering, screen-reader announcements, visible focus and reduced motion support. Light and dark themes.
- AdSense-ready: ads.txt, auto ads and manual ad slots, plus Privacy Policy, Terms, Disclaimer, About and Contact pages and 7 in-depth guides.
- No framework and no npm dependencies. The build is a single Node script.

## Project structure

```
site.config.json        ← the only file you normally need to edit
build.mjs               ← static site builder (src → dist)
serve.mjs               ← local preview server
.github/workflows/      ← automatic deploy to GitHub Pages
src/
  pages/                ← one HTML file per page (meta block at the top)
    guides/             ← articles (layout: "article")
  partials/             ← header and footer
  assets/css/style.css  ← design system
  assets/js/            ← converter.js, pdf-writer.js, zip.js, main.js
  assets/vendor/        ← heic2any (MIT), loaded only when a HEIC file is added
  static/               ← favicon, app icons, og-image.png (copied to site root)
  sw.js                 ← service worker template
```

## Run locally

Requires Node.js 20 or newer.

```bash
npm run dev       # build, serve on http://localhost:8080 and rebuild on changes
npm run build     # build once into dist/
```

## Configuration (`site.config.json`)

| Key | What it does |
| --- | --- |
| `siteUrl` | `https://<your-github-username>.github.io`. If you leave the `USERNAME` placeholder, the GitHub Actions build detects it automatically. |
| `basePath` | Leave `""` for a `<username>.github.io` repository. For a project repository, use `"/<repo-name>"` (also auto-detected on GitHub Actions). |
| `contactEmail` | Shown on the Contact, Privacy, Terms and About pages. **Required before applying to AdSense.** |
| `githubRepo` | Optional `owner/repo`. Adds a "Report a bug" link on the Contact page. |
| `adsense.publisherId` | Your `ca-pub-XXXXXXXXXXXXXXXX` ID. Enables the AdSense script, the verification meta tag and `ads.txt`. |
| `adsense.slots.*` | Optional ad unit IDs for manual placements (`home`, `article`, `footer`). Leave empty to rely on Auto ads only. |
| `analytics.ga4MeasurementId` | Optional Google Analytics 4 ID (`G-XXXXXXX`). The Privacy Policy adapts automatically. |
| `verification.google` / `bing` | Optional Search Console / Bing Webmaster verification tokens. |
| `lastPolicyUpdate` | Date shown on the legal pages. Update it when you change them. |

To test a different configuration without editing the real one: `SITE_CONFIG=path/to/other.json node build.mjs`.

## Deploy to GitHub Pages

1. Create a **public** repository named exactly `<your-github-username>.github.io`.
   AdSense needs `ads.txt` at the root of the domain, which only this repository type provides.
2. Push this project to the `main` branch:
   ```bash
   git init
   git add .
   git commit -m "Initial site"
   git branch -M main
   git remote add origin https://github.com/<username>/<username>.github.io.git
   git push -u origin main
   ```
3. On GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Open the **Actions** tab. When the "Deploy to GitHub Pages" workflow finishes, the site is live at `https://<username>.github.io/`.

Every push to `main` rebuilds and redeploys automatically.

## Google Search Console (do this first)

1. Add the property `https://<username>.github.io/` in [Google Search Console](https://search.google.com/search-console).
2. Choose the **HTML tag** method, copy the `content` value into `verification.google`, push, then click **Verify**.
3. Under **Sitemaps**, submit `sitemap.xml`.

## Google AdSense

1. Set `contactEmail`, push, and make sure the site is live and indexed. Give it a little time to receive some organic traffic.
2. Apply at [adsense.google.com](https://adsense.google.com) with the site `<username>.github.io`.
3. Copy your publisher ID (`ca-pub-…`) into `adsense.publisherId` and push. This adds the AdSense code, the `google-adsense-account` meta tag and `https://<username>.github.io/ads.txt`.
4. In AdSense, request review of the site. Approval commonly takes from a few days to a few weeks.
5. After approval:
   - Turn on **Auto ads**, or create display ad units and put their slot IDs in `adsense.slots`.
   - Under **Privacy & messaging**, enable the **European regulations (GDPR) message**. This is Google's certified consent platform, required for visitors in the EEA, UK and Switzerland. Also consider the US state regulations message.

**Policy reminders:** never click your own ads or ask others to click them. Don't place ads right next to the Convert or Download buttons. Keep the content original.

> **Note about github.io:** AdSense reviews sites on free subdomains more strictly, and approval is not guaranteed. If you're repeatedly rejected for reasons unrelated to content, a custom domain (see below) is the most reliable fix. It needs no code changes.

## AI visibility and instant indexing

Every build generates:

| File | Purpose |
| --- | --- |
| `/llms.txt` | Short summary and link index for AI assistants ([llmstxt.org](https://llmstxt.org/)) |
| `/llms-full.txt` | Full text of every page in one Markdown file |
| `/<page>/index.html.md` | Markdown version of each page, linked with `<link rel="alternate" type="text/markdown">` |
| `/robots.txt` | Explicitly allows AI search and assistant crawlers (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended and more) |
| `/ai.txt` | AI usage permissions |
| `/feed.xml` | Atom feed of guides, used by aggregators and search engines for faster discovery |
| `/.well-known/security.txt` | Standard security contact |
| `/<indexNowKey>.txt` | IndexNow ownership key |

Structured data includes WebApplication, HowTo, FAQPage, Article, BreadcrumbList and Organization.

**IndexNow:** after each deployment, the `Notify IndexNow` job submits the pages that changed in that push to Bing, Yandex, Seznam, Naver and Yep. To submit every URL manually, run **Actions → Deploy to GitHub Pages → Run workflow**. To use your own key, put any 32-character hex string in `indexNowKey`. Google does not use IndexNow, so keep submitting the sitemap in Search Console. Bing Webmaster Tools can import your site directly from Search Console.

## Using a custom domain later

1. Buy a domain and add the DNS records described in the [GitHub Pages custom domain docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site).
2. Create `src/static/CNAME` containing just your domain, for example `imagetopdf.example`.
3. Set `siteUrl` to `https://imagetopdf.example`, then push.
4. In **Settings → Pages**, enter the domain and enable **Enforce HTTPS**.
5. Add the new domain in Search Console and AdSense.

## Writing a new guide

Create `src/pages/guides/<slug>.html`:

```html
<!--meta
{
  "title": "SEO title (max ~60 characters)",
  "h1": "Heading shown on the page",
  "breadcrumb": "Short name",
  "description": "Meta description (max ~160 characters)",
  "excerpt": "One-line summary for guide cards",
  "category": "Basics",
  "layout": "article",
  "nav": "guides",
  "order": 8,
  "published": "2026-10-01",
  "updated": "2026-10-01",
  "priority": 0.7
}
-->
<p>Intro paragraph…</p>
<h2>First section</h2>
<p>…</p>
```

The table of contents, reading time, Article and Breadcrumb structured data, related guides, sitemap entry and in-article ads are generated automatically. Use `{{base}}` in front of internal links, for example `href="{{base}}/guides/"`.

## Launch checklist

- [ ] `contactEmail` set and inbox monitored
- [ ] Site deployed and every page opens without errors
- [ ] Search Console verified and sitemap submitted
- [ ] `adsense.publisherId` set and `/ads.txt` reachable
- [ ] GDPR consent message enabled in AdSense Privacy & messaging
- [ ] Link shared in a few relevant places to get initial visitors

## Third-party software

- [heic2any](https://github.com/alexcorvi/heic2any) (MIT License). HEIC/HEIF decoding in the browser, bundled in `src/assets/vendor/`.
