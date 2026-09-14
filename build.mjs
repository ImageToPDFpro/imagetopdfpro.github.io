#!/usr/bin/env node
/**
 * Zero-dependency static site builder.
 *
 *   node build.mjs            -> builds ./dist from ./src using site.config.json
 *
 * Pages live in src/pages. Each starts with a meta block:
 *   <!--meta { "title": "...", "description": "...", "layout": "page" } -->
 * Layouts: "home" (raw body), "page" (legal/info pages), "article" (guides).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const toPosix = (p) => p.split(path.sep).join('/');
const escapeHtml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stripTags = (s = '') =>
  s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/\s+/g, ' ').trim();
const slugify = (s) =>
  stripTags(s).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const formatDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const today = () => new Date().toISOString().slice(0, 10);

const warnings = [];
const warn = (msg) => warnings.push(msg);

async function walk(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function writeFile(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

/* ------------------------------------------------------------------ config */

async function loadConfig() {
  // SITE_CONFIG lets you build with an alternative config (e.g. a staging copy) without editing the real one.
  const cfgPath = process.env.SITE_CONFIG ? path.resolve(process.env.SITE_CONFIG) : path.join(ROOT, 'site.config.json');
  const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
  cfg.siteUrl = String(cfg.siteUrl || '').trim().replace(/\/+$/, '');
  let base = String(cfg.basePath || '').trim().replace(/\/+$/, '');
  if (base && !base.startsWith('/')) base = `/${base}`;

  // On GitHub Actions, fill in the placeholder URL from the repository automatically.
  const owner = (process.env.GITHUB_REPOSITORY_OWNER || '').toLowerCase();
  const repo = (process.env.GITHUB_REPOSITORY || '').split('/')[1] || '';
  if ((!cfg.siteUrl || cfg.siteUrl.includes('USERNAME')) && owner) {
    cfg.siteUrl = `https://${owner}.github.io`;
    if (!base && repo && repo.toLowerCase() !== `${owner}.github.io`) base = `/${repo}`;
    console.log(`ℹ Using ${cfg.siteUrl}${base} (detected from GitHub repository)`);
  }
  cfg.basePath = base;
  cfg.fullUrl = cfg.siteUrl + base;

  cfg.adsense = cfg.adsense || {};
  cfg.adsense.slots = cfg.adsense.slots || {};
  const pub = String(cfg.adsense.publisherId || '').trim().replace(/^ca-/, '');
  if (pub && !/^pub-\d{10,20}$/.test(pub)) {
    warn(`adsense.publisherId "${cfg.adsense.publisherId}" does not look like "ca-pub-0000000000000000".`);
  }
  cfg.adsense.pub = pub;
  cfg.analytics = cfg.analytics || {};
  cfg.verification = cfg.verification || {};

  if (!cfg.siteUrl || cfg.siteUrl.includes('USERNAME')) {
    warn('siteUrl still contains the USERNAME placeholder. Set it to https://<your-github-username>.github.io');
  }
  if (!cfg.contactEmail) warn('contactEmail is empty. AdSense reviewers expect a working contact method.');
  if (!pub) warn('adsense.publisherId is empty. Ads and ads.txt are disabled until you add it.');
  return cfg;
}

/* ------------------------------------------------------------------ assets */

const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"?]+?\.js)\2/g;

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

async function processAssets() {
  const dir = path.join(SRC, 'assets');
  const files = await walk(dir);
  const raw = new Map();
  for (const f of files) raw.set(toPosix(path.relative(dir, f)), await fs.readFile(f));

  const versions = new Map();
  const versionOf = (rel, seen = new Set()) => {
    if (versions.has(rel)) return versions.get(rel);
    seen.add(rel);
    const buf = raw.get(rel);
    const hash = crypto.createHash('sha256').update(buf);
    if (rel.endsWith('.js') && !rel.startsWith('vendor/')) {
      for (const m of buf.toString('utf8').matchAll(IMPORT_RE)) {
        const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[3]));
        if (raw.has(dep) && !seen.has(dep)) hash.update(versionOf(dep, seen));
      }
    }
    const v = hash.digest('hex').slice(0, 10);
    versions.set(rel, v);
    return v;
  };

  for (const [rel, buf] of raw) {
    versionOf(rel);
    let out = buf;
    if (rel.endsWith('.js') && !rel.startsWith('vendor/')) {
      out = buf.toString('utf8').replace(IMPORT_RE, (all, pre, q, spec) => {
        const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
        return raw.has(dep) ? `${pre}${q}${spec}?v=${versionOf(dep)}${q}` : all;
      });
    } else if (rel.endsWith('.css')) {
      out = minifyCss(buf.toString('utf8'));
    }
    await writeFile(path.join(DIST, 'assets', rel), out);
  }
  return versions;
}

async function copyStatic() {
  const dir = path.join(SRC, 'static');
  const copied = [];
  for (const f of await walk(dir)) {
    const rel = toPosix(path.relative(dir, f));
    await writeFile(path.join(DIST, rel), await fs.readFile(f));
    copied.push(rel);
  }
  return copied;
}

/* ------------------------------------------------------------------- pages */

async function loadPages() {
  const dir = path.join(SRC, 'pages');
  const files = (await walk(dir)).filter((f) => f.endsWith('.html'));
  const pages = [];
  for (const file of files) {
    const rel = toPosix(path.relative(dir, file));
    const text = await fs.readFile(file, 'utf8');
    const m = text.match(/^\s*<!--meta\s*([\s\S]*?)-->\s*/);
    if (!m) throw new Error(`${rel}: missing <!--meta {...} --> block`);
    let meta;
    try {
      meta = JSON.parse(m[1]);
    } catch (err) {
      throw new Error(`${rel}: invalid meta JSON (${err.message})`);
    }
    let url;
    if (rel === 'index.html') url = '/';
    else if (rel === '404.html') url = '/404.html';
    else if (rel.endsWith('/index.html')) url = `/${rel.slice(0, -'index.html'.length)}`;
    else url = `/${rel.replace(/\.html$/, '')}/`;
    const outFile = url.endsWith('/') ? `${url}index.html` : url;
    pages.push({ rel, url, outFile, meta, body: text.slice(m[0].length) });
  }
  return pages;
}

/* --------------------------------------------------------------- templates */

function renderConditionals(str, flags) {
  return str.replace(/\{\{#if (\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g, (_, key, yes, no = '') =>
    flags[key] ? yes : no
  );
}

function adUnit(cfg, name) {
  const slot = cfg.adsense.slots?.[name];
  if (!cfg.adsense.pub || !slot) return '';
  return `<aside class="ad-slot" aria-label="Advertisement">
  <span class="ad-label">Advertisement</span>
  <ins class="adsbygoogle" style="display:block" data-ad-client="ca-${cfg.adsense.pub}" data-ad-slot="${escapeHtml(slot)}" data-ad-format="auto" data-full-width-responsive="true"></ins>
  <script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
</aside>`;
}

function guideCards(guides, limit) {
  const list = limit ? guides.slice(0, limit) : guides;
  return `<ul class="card-grid" role="list">${list
    .map(
      (g) => `
  <li class="card guide-card">
    <p class="eyebrow">${escapeHtml(g.meta.category || 'Guide')}</p>
    <h3><a class="stretched-link" href="{{base}}${g.url}">${escapeHtml(g.meta.h1 || g.meta.title)}</a></h3>
    <p>${escapeHtml(g.meta.excerpt || g.meta.description)}</p>
    <p class="card-meta">${g.readingTime} min read</p>
  </li>`
    )
    .join('')}
</ul>`;
}

function fillTokens(str, ctx) {
  const { cfg, versions, guides } = ctx;
  const flags = {
    contactEmail: !!cfg.contactEmail,
    githubRepo: !!cfg.githubRepo,
    adsense: !!cfg.adsense.pub,
    analytics: !!cfg.analytics.ga4MeasurementId,
  };
  const contactLink = cfg.contactEmail
    ? `<a href="mailto:${escapeHtml(cfg.contactEmail)}">${escapeHtml(cfg.contactEmail)}</a>`
    : '<strong>[set contactEmail in site.config.json]</strong>';

  let out = renderConditionals(str, flags);
  out = out
    .replace(/\{\{guides_list(?::(\d+))?\}\}/g, (_, n) => guideCards(guides, n ? Number(n) : 0))
    .replace(/\{\{ad:(\w+)\}\}/g, (_, name) => adUnit(cfg, name))
    .replace(/\{\{asset:([^}]+)\}\}/g, (_, rel) => {
      if (!versions.has(rel)) warn(`Unknown asset referenced: ${rel}`);
      return `${cfg.basePath}/assets/${rel}?v=${versions.get(rel) || '0'}`;
    });
  return out
    .replace(/\{\{base\}\}/g, cfg.basePath)
    .replace(/\{\{siteUrl\}\}/g, cfg.fullUrl)
    .replace(/\{\{siteName\}\}/g, escapeHtml(cfg.siteName))
    .replace(/\{\{shortName\}\}/g, escapeHtml(cfg.shortName))
    .replace(/\{\{contactEmailLink\}\}/g, contactLink)
    .replace(/\{\{contactEmail\}\}/g, escapeHtml(cfg.contactEmail || ''))
    .replace(/\{\{githubRepo\}\}/g, escapeHtml(cfg.githubRepo || ''))
    .replace(/\{\{policyDate\}\}/g, formatDate(cfg.lastPolicyUpdate || today()))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
}

function addHeadingIds(html) {
  const used = new Set();
  const toc = [];
  const body = html.replace(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/g, (all, attrs = '', inner) => {
    let id = (attrs.match(/\sid="([^"]+)"/) || [])[1];
    if (!id) {
      id = slugify(inner) || 'section';
      let n = 2;
      while (used.has(id)) id = `${slugify(inner)}-${n++}`;
      attrs = `${attrs} id="${id}"`;
    }
    used.add(id);
    toc.push({ id, text: stripTags(inner) });
    return `<h2${attrs}>${inner}</h2>`;
  });
  return { body, toc };
}

function breadcrumbHtml(items) {
  return `<nav class="breadcrumb" aria-label="Breadcrumb"><ol>${items
    .map((it, i) =>
      i === items.length - 1
        ? `<li><span aria-current="page">${escapeHtml(it.name)}</span></li>`
        : `<li><a href="{{base}}${it.url}">${escapeHtml(it.name)}</a></li>`
    )
    .join('')}</ol></nav>`;
}

function layoutArticle(page, ctx) {
  const { meta } = page;
  const { cfg, guides } = ctx;
  let { body, toc } = addHeadingIds(page.body);

  // Auto-place in-article ads: before the 3rd section and at the end.
  if (adUnit(cfg, 'article')) {
    let count = 0;
    body = body.replace(/<h2[\s>]/g, (m) => (++count === 3 ? `{{ad:article}}\n${m}` : m));
  }

  const idx = guides.indexOf(page);
  const related = [1, 2, 3].map((o) => guides[(idx + o) % guides.length]).filter((g) => g && g !== page);
  const updated = meta.updated || meta.published;

  return `
<div class="container article-layout">
  ${breadcrumbHtml([{ name: 'Home', url: '/' }, { name: 'Guides', url: '/guides/' }, { name: meta.breadcrumb || meta.h1 }])}
  <article class="article">
    <header class="article-header">
      <p class="eyebrow">${escapeHtml(meta.category || 'Guide')}</p>
      <h1>${escapeHtml(meta.h1 || meta.title)}</h1>
      <p class="lede">${escapeHtml(meta.description)}</p>
      <p class="article-meta">
        <span>Updated <time datetime="${updated}">${formatDate(updated)}</time></span>
        <span aria-hidden="true">·</span>
        <span>${page.readingTime} min read</span>
      </p>
    </header>
    ${
      toc.length > 2
        ? `<nav class="toc" aria-labelledby="toc-title">
      <p class="toc-title" id="toc-title">On this page</p>
      <ol>${toc.map((t) => `<li><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`).join('')}</ol>
    </nav>`
        : ''
    }
    <div class="prose">
${body}
    </div>
    <aside class="cta-card">
      <div>
        <h2 class="cta-title">Ready to make your PDF?</h2>
        <p>Drop your images into the free converter. It runs in your browser, so nothing is uploaded.</p>
      </div>
      <a class="btn btn-primary btn-lg" href="{{base}}/">Open the converter</a>
    </aside>
    {{ad:article}}
  </article>
  ${
    related.length
      ? `<section class="related" aria-labelledby="related-title">
    <h2 id="related-title">More guides</h2>
    ${guideCards(related)}
  </section>`
      : ''
  }
</div>`;
}

function layoutPage(page) {
  const { meta } = page;
  return `
<div class="container narrow">
  ${breadcrumbHtml([{ name: 'Home', url: '/' }, { name: meta.breadcrumb || meta.h1 }])}
  <header class="page-header">
    <h1>${escapeHtml(meta.h1 || meta.title)}</h1>
    ${meta.lede ? `<p class="lede">${escapeHtml(meta.lede)}</p>` : ''}
    ${meta.showUpdated ? '<p class="article-meta">Last updated: {{policyDate}}</p>' : ''}
  </header>
  <div class="prose">
${page.body}
  </div>
</div>`;
}

/* ------------------------------------------------------------ structured data */

function jsonLd(page, ctx) {
  const { cfg } = ctx;
  const { meta } = page;
  const url = cfg.fullUrl + page.url;
  const org = {
    '@type': 'Organization',
    '@id': `${cfg.fullUrl}/#organization`,
    name: cfg.siteName,
    url: `${cfg.fullUrl}/`,
    logo: { '@type': 'ImageObject', url: `${cfg.fullUrl}/icon-512.png`, width: 512, height: 512 },
  };
  if (cfg.contactEmail) org.email = cfg.contactEmail;
  const graph = [
    org,
    {
      '@type': 'WebSite',
      '@id': `${cfg.fullUrl}/#website`,
      url: `${cfg.fullUrl}/`,
      name: cfg.siteName,
      description: cfg.description,
      inLanguage: 'en',
      publisher: { '@id': `${cfg.fullUrl}/#organization` },
    },
  ];

  const crumbs = [{ name: 'Home', url: '/' }];
  if (meta.layout === 'article') crumbs.push({ name: 'Guides', url: '/guides/' });
  if (page.url !== '/') crumbs.push({ name: meta.breadcrumb || meta.h1 || meta.title, url: page.url });

  if (meta.layout === 'home') {
    graph.push({
      '@type': 'WebApplication',
      '@id': `${url}#app`,
      name: cfg.siteName,
      url,
      description: meta.description,
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Any',
      browserRequirements: 'Requires JavaScript and a modern web browser.',
      isAccessibleForFree: true,
      inLanguage: 'en',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      featureList: meta.features || [],
      publisher: { '@id': `${cfg.fullUrl}/#organization` },
    });
  } else if (meta.layout === 'article') {
    graph.push({
      '@type': 'Article',
      '@id': `${url}#article`,
      headline: meta.h1 || meta.title,
      description: meta.description,
      image: `${cfg.fullUrl}/og-image.png`,
      datePublished: meta.published,
      dateModified: meta.updated || meta.published,
      wordCount: page.wordCount,
      inLanguage: 'en',
      author: { '@id': `${cfg.fullUrl}/#organization` },
      publisher: { '@id': `${cfg.fullUrl}/#organization` },
      mainEntityOfPage: url,
    });
  } else {
    graph.push({
      '@type': meta.schemaType || 'WebPage',
      '@id': `${url}#webpage`,
      url,
      name: meta.title,
      description: meta.description,
      inLanguage: 'en',
      isPartOf: { '@id': `${cfg.fullUrl}/#website` },
    });
  }

  if (crumbs.length > 1) {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: crumbs.map((c, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: c.name,
        item: cfg.fullUrl + c.url,
      })),
    });
  }

  // FAQ markup is derived from the visible <details class="faq-item"> blocks.
  const faqs = [...page.body.matchAll(/<details class="faq-item"[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)];
  if (faqs.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: faqs.map((f) => ({
        '@type': 'Question',
        name: stripTags(f[1]),
        acceptedAnswer: { '@type': 'Answer', text: stripTags(fillTokens(f[2], ctx)) },
      })),
    });
  }

  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}

/* --------------------------------------------------------------- document */

function renderDocument(page, ctx, partials) {
  const { cfg } = ctx;
  const { meta } = page;
  const isArticle = meta.layout === 'article';
  const canonical = cfg.fullUrl + page.url;
  const title = meta.title.includes(cfg.siteName) ? meta.title : `${meta.title} | ${cfg.siteName}`;
  const ogImage = `${cfg.fullUrl}/og-image.png`;
  const robots = meta.noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large, max-snippet:-1';

  let main;
  if (meta.layout === 'article') main = layoutArticle(page, ctx);
  else if (meta.layout === 'page') main = layoutPage(page);
  else main = page.body;

  const header = partials.header.replace(/data-nav="(\w+)"/g, (_, key) =>
    key === meta.nav ? 'aria-current="page"' : ''
  );

  const scripts = (meta.scripts || [])
    .map((s) => `<script type="module" src="{{asset:${s}}}"></script>`)
    .join('\n');

  const html = `<!doctype html>
<html lang="en" data-base="{{base}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(meta.description)}">
<meta name="robots" content="${robots}">
${meta.noindex ? '' : `<link rel="canonical" href="${canonical}">`}
<meta name="theme-color" content="${cfg.themeColor}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#161412" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="format-detection" content="telephone=no">
<meta name="application-name" content="{{shortName}}">
<meta name="apple-mobile-web-app-title" content="{{shortName}}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">

<meta property="og:type" content="${isArticle ? 'article' : 'website'}">
<meta property="og:site_name" content="{{siteName}}">
<meta property="og:locale" content="en_US">
<meta property="og:title" content="${escapeHtml(meta.ogTitle || meta.h1 || meta.title)}">
<meta property="og:description" content="${escapeHtml(meta.description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{{siteName}}: convert images to PDF in your browser">
${isArticle ? `<meta property="article:published_time" content="${meta.published}">\n<meta property="article:modified_time" content="${meta.updated || meta.published}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(meta.ogTitle || meta.h1 || meta.title)}">
<meta name="twitter:description" content="${escapeHtml(meta.description)}">
<meta name="twitter:image" content="${ogImage}">

<link rel="icon" href="{{base}}/favicon.ico" sizes="32x32">
<link rel="icon" href="{{base}}/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="{{base}}/apple-touch-icon.png">
<link rel="manifest" href="{{base}}/manifest.webmanifest">
<link rel="sitemap" type="application/xml" href="{{base}}/sitemap.xml">
${cfg.verification.google ? `<meta name="google-site-verification" content="${escapeHtml(cfg.verification.google)}">` : ''}
${cfg.verification.bing ? `<meta name="msvalidate.01" content="${escapeHtml(cfg.verification.bing)}">` : ''}
${cfg.adsense.pub ? `<meta name="google-adsense-account" content="ca-${cfg.adsense.pub}">` : ''}

<script>(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}})();</script>
<link rel="stylesheet" href="{{asset:css/style.css}}">
<script type="application/ld+json">${jsonLd(page, ctx)}</script>
${
  cfg.adsense.pub
    ? `<link rel="preconnect" href="https://pagead2.googlesyndication.com" crossorigin>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-${cfg.adsense.pub}" crossorigin="anonymous"></script>`
    : ''
}
${
  cfg.analytics.ga4MeasurementId
    ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${escapeHtml(cfg.analytics.ga4MeasurementId)}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${escapeHtml(cfg.analytics.ga4MeasurementId)}');</script>`
    : ''
}
</head>
<body class="${escapeHtml(meta.bodyClass || `layout-${meta.layout || 'page'}`)}">
<a class="skip-link" href="#main">Skip to content</a>
${header}
<main id="main" tabindex="-1">
${main}
</main>
${partials.footer}
<script type="module" src="{{asset:js/main.js}}"></script>
${scripts}
</body>
</html>
`;
  return fillTokens(html, ctx).replace(/\n{3,}/g, '\n\n');
}

/* --------------------------------------------------------- generated files */

function sitemapXml(pages, cfg) {
  const urls = pages
    .filter((p) => !p.meta.noindex)
    .sort((a, b) => a.url.localeCompare(b.url))
    .map((p) => {
      const lastmod = p.meta.updated || p.meta.published || (p.meta.showUpdated ? cfg.lastPolicyUpdate : null) || today();
      return `  <url>
    <loc>${cfg.fullUrl}${p.url}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${p.meta.changefreq || 'monthly'}</changefreq>
    <priority>${p.meta.priority ?? 0.5}</priority>
  </url>`;
    });
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

function manifestJson(cfg) {
  const b = cfg.basePath;
  return JSON.stringify(
    {
      id: `${b}/`,
      name: cfg.siteName,
      short_name: cfg.shortName,
      description: cfg.description,
      lang: 'en',
      dir: 'ltr',
      start_url: `${b}/?source=pwa`,
      scope: `${b}/`,
      display: 'standalone',
      display_override: ['window-controls-overlay', 'standalone'],
      orientation: 'any',
      background_color: cfg.backgroundColor,
      theme_color: cfg.themeColor,
      categories: ['productivity', 'utilities'],
      icons: [
        { src: `${b}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `${b}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `${b}/icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: `${b}/favicon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      ],
      share_target: {
        action: `${b}/share-target/`,
        method: 'POST',
        enctype: 'multipart/form-data',
        params: { files: [{ name: 'images', accept: ['image/*', '.heic', '.heif'] }] },
      },
      file_handlers: [
        {
          action: `${b}/`,
          accept: {
            'image/jpeg': ['.jpg', '.jpeg'],
            'image/png': ['.png'],
            'image/webp': ['.webp'],
            'image/gif': ['.gif'],
            'image/bmp': ['.bmp'],
            'image/avif': ['.avif'],
            'image/heic': ['.heic'],
            'image/heif': ['.heif'],
          },
        },
      ],
    },
    null,
    2
  );
}

/* -------------------------------------------------------------------- main */

export async function build() {
  const started = Date.now();
  warnings.length = 0;
  const cfg = await loadConfig();

  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  const versions = await processAssets();
  const staticFiles = await copyStatic();
  const partials = {
    header: await fs.readFile(path.join(SRC, 'partials', 'header.html'), 'utf8'),
    footer: await fs.readFile(path.join(SRC, 'partials', 'footer.html'), 'utf8'),
  };

  const pages = await loadPages();
  for (const p of pages) {
    const words = stripTags(p.body).split(' ').filter(Boolean).length;
    p.wordCount = words;
    p.readingTime = Math.max(1, Math.round(words / 230));
    for (const key of ['title', 'description']) {
      if (!p.meta[key]) throw new Error(`${p.rel}: meta.${key} is required`);
    }
    if (!p.meta.noindex && p.meta.description.length > 165) {
      warn(`${p.rel}: description is ${p.meta.description.length} chars (aim for 165 or fewer).`);
    }
  }
  const guides = pages
    .filter((p) => p.meta.layout === 'article')
    .sort((a, b) => (a.meta.order ?? 99) - (b.meta.order ?? 99));

  const ctx = { cfg, versions, guides };
  for (const p of pages) {
    await writeFile(path.join(DIST, p.outFile), renderDocument(p, ctx, partials));
  }

  // Service worker: precache the app shell and every page for offline use.
  const precache = [
    ...pages.filter((p) => p.url !== '/404.html').map((p) => cfg.basePath + p.url),
    ...[...versions.keys()]
      .filter((rel) => !rel.startsWith('vendor/'))
      .map((rel) => `${cfg.basePath}/assets/${rel}?v=${versions.get(rel)}`),
    ...staticFiles.filter((f) => /\.(png|svg|ico)$/.test(f) && !f.startsWith('og-')).map((f) => `${cfg.basePath}/${f}`),
    `${cfg.basePath}/manifest.webmanifest`,
  ];
  const buildId = crypto.createHash('sha256').update(JSON.stringify([...versions]) + pages.map((p) => p.body).join('')).digest('hex').slice(0, 12);
  const sw = (await fs.readFile(path.join(SRC, 'sw.js'), 'utf8'))
    .replace('__VERSION__', buildId)
    .replace('__BASE__', cfg.basePath)
    .replace('__PRECACHE__', JSON.stringify(precache, null, 2));
  await writeFile(path.join(DIST, 'sw.js'), sw);

  await writeFile(path.join(DIST, 'manifest.webmanifest'), manifestJson(cfg));
  await writeFile(path.join(DIST, 'sitemap.xml'), sitemapXml(pages, cfg));
  await writeFile(
    path.join(DIST, 'robots.txt'),
    `# ${cfg.siteName}\nUser-agent: *\nAllow: /\nDisallow: ${cfg.basePath}/share-target/\n\nSitemap: ${cfg.fullUrl}/sitemap.xml\n`
  );
  if (cfg.adsense.pub) {
    await writeFile(path.join(DIST, 'ads.txt'), `google.com, ${cfg.adsense.pub}, DIRECT, f08c47fec0942fa0\n`);
  }
  await writeFile(path.join(DIST, '.nojekyll'), '');

  console.log(`\n✔ Built ${pages.length} pages, ${versions.size} assets in ${Date.now() - started} ms -> dist/`);
  if (warnings.length) {
    console.log('\n⚠ Warnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }
  console.log('');
  return { cfg, pages };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  build().catch((err) => {
    console.error(`\n✖ Build failed: ${err.message}\n`);
    process.exit(1);
  });
}
