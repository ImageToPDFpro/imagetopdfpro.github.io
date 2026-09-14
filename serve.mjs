#!/usr/bin/env node
/**
 * Local preview server for ./dist (mirrors GitHub Pages behaviour).
 *
 *   node serve.mjs            -> build once, serve on http://localhost:8080
 *   node serve.mjs --watch    -> rebuild automatically when src/ or site.config.json changes
 */
import http from 'node:http';
import { promises as fs, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

let { cfg } = await build();

async function exists(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const base = cfg.basePath;
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    if (base) {
      if (pathname === '/' || pathname === base) {
        res.writeHead(302, { Location: `${base}/` });
        return res.end();
      }
      if (!pathname.startsWith(`${base}/`)) return notFound(res);
      pathname = pathname.slice(base.length);
    }

    let file = path.normalize(path.join(DIST, pathname));
    if (!file.startsWith(DIST)) return notFound(res);

    if (pathname.endsWith('/')) file = path.join(file, 'index.html');
    else if (!(await exists(file)) && (await exists(path.join(file, 'index.html')))) {
      res.writeHead(301, { Location: `${base}${pathname}/` });
      return res.end();
    }

    if (!(await exists(file))) return notFound(res);
    const body = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(String(err));
  }
});

async function notFound(res) {
  const page = path.join(DIST, '404.html');
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end((await exists(page)) ? await fs.readFile(page) : 'Not found');
}

server.listen(PORT, () => {
  console.log(`Serving dist/ at http://localhost:${PORT}${cfg.basePath}/`);
});

if (process.argv.includes('--watch')) {
  let timer;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        ({ cfg } = await build());
      } catch (err) {
        console.error(`✖ ${err.message}`);
      }
    }, 150);
  };
  watch(path.join(ROOT, 'src'), { recursive: true }, rebuild);
  watch(path.join(ROOT, 'site.config.json'), rebuild);
  console.log('Watching src/ and site.config.json for changes…');
}
