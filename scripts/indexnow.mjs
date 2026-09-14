#!/usr/bin/env node
/**
 * Notifies IndexNow (Bing, Yandex, Seznam, Naver, Yep) about pages that changed in the latest push.
 * Runs in GitHub Actions after deployment, once `node build.mjs` has produced dist/.
 *
 *   node scripts/indexnow.mjs          -> submit pages changed since BEFORE_SHA (all pages if unknown)
 *   node scripts/indexnow.mjs --all    -> submit every URL in the sitemap
 *   add --dry-run to print the URLs without submitting
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, pageUrlFor } from '../build.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = await loadConfig();
if (!cfg.indexNowKey) {
  console.log('indexNowKey is not set in site.config.json; skipping IndexNow.');
  process.exit(0);
}
if (!cfg.siteUrl || cfg.siteUrl.includes('USERNAME')) {
  console.log('siteUrl is not configured; skipping IndexNow.');
  process.exit(0);
}

const sitemap = readFileSync(path.join(ROOT, 'dist', 'sitemap.xml'), 'utf8');
const allUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

function changedUrls() {
  const before = process.env.BEFORE_SHA || '';
  if (process.argv.includes('--all') || !/^[0-9a-f]{40}$/.test(before) || /^0+$/.test(before)) return allUrls;
  let files;
  try {
    files = execFileSync('git', ['diff', '--name-only', before, 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return allUrls;
  }
  // Layout, styles, scripts or config changes affect every page.
  const affectsAll = files.some(
    (f) => f === 'site.config.json' || f === 'build.mjs' || (f.startsWith('src/') && !f.startsWith('src/pages/'))
  );
  if (affectsAll) return allUrls;
  return files
    .filter((f) => f.startsWith('src/pages/') && f.endsWith('.html'))
    .map((f) => cfg.fullUrl + pageUrlFor(f.slice('src/pages/'.length)))
    .filter((url) => allUrls.includes(url));
}

const urls = changedUrls();
if (process.argv.includes('--dry-run')) {
  console.log(`Would submit ${urls.length} URL(s):\n${urls.join('\n')}`);
  process.exit(0);
}
if (!urls.length) {
  console.log('No page content changed; nothing to submit to IndexNow.');
  process.exit(0);
}

// IndexNow verifies ownership through the key file, so wait until the new deployment serves it.
const keyLocation = `${cfg.fullUrl}/${cfg.indexNowKey}.txt`;
let live = false;
for (let attempt = 0; attempt < 18 && !live; attempt++) {
  try {
    const res = await fetch(`${keyLocation}?t=${Date.now()}`, { cache: 'no-store' });
    live = res.ok && (await res.text()).trim() === cfg.indexNowKey;
  } catch {
    /* not reachable yet */
  }
  if (!live) await sleep(10_000);
}
if (!live) {
  console.log(`::warning::IndexNow key file is not reachable at ${keyLocation}; skipping submission.`);
  process.exit(0);
}

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    host: new URL(cfg.siteUrl).host,
    key: cfg.indexNowKey,
    keyLocation,
    urlList: urls.slice(0, 10_000),
  }),
});

if (res.status === 200 || res.status === 202) {
  console.log(`IndexNow accepted ${urls.length} URL(s) (HTTP ${res.status}):\n${urls.join('\n')}`);
} else {
  console.log(`::warning::IndexNow responded with HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
