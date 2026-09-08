/* ============================================================================
 * first-commit — server
 * ----------------------------------------------------------------------------
 * Serves the static course and the JSON API from one origin, so the session
 * cookie is first-party and there is no CORS to configure.
 *
 * Zero dependencies, on purpose: the course itself promises no build step and
 * no packages, and an optional backend that dragged in a framework would make
 * that promise false for anyone who ran it.
 *
 *   npm start                 http://localhost:8000
 *   PORT=3000 npm start
 *   FC_DATA=./data/fc.json    where the JSON document lives
 *   FC_OWNER_EMAILS=a@b.com   accounts that get the owner role on sign-up
 *   FC_SECURE_COOKIES=1       set behind HTTPS
 * ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { createApi } from './api.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

/* The app has no inline scripts and talks to nothing off-origin, so it can run
   under a policy strict enough to make an injected <script> inert. The one
   exception is the optional YouTube embed, which is framed, never scripted. */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-src https://www.youtube-nocookie.com",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

/**
 * What a browser is allowed to ask for.
 *
 * An allowlist, not a denylist, because the repository root holds several
 * things a learner must never receive: the accounts file with its password
 * hashes and live session tokens (`data/`), the reference solution to every
 * challenge (`tests/fixtures-solutions.json`), and unpublished module drafts.
 * A denylist would be one forgotten entry away from leaking any of them.
 */
const PUBLIC_FILES = new Set(['index.html', 'app.html', 'admin.html', 'favicon.ico']);
const PUBLIC_DIRS = ['css', 'ui', 'engine', 'content', 'assets'];

function isPublic(rel) {
  const parts = rel.split(/[/\\]/);
  // No empty, relative or hidden segment anywhere in the path.
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))) return false;
  if (parts.length === 1) return PUBLIC_FILES.has(parts[0]);
  return PUBLIC_DIRS.includes(parts[0]);
}

/** Resolve a URL path inside ROOT, or null if it escapes or is not public. */
function resolveStatic(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!isPublic(rel)) return null;
  const full = path.resolve(ROOT, rel);
  // path.resolve collapses `..`; with the check above this is belt and braces.
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

async function serveStatic(req, res, url) {
  const file = resolveStatic(url.pathname);
  // 404 rather than 403: a different status for "exists but private" would
  // confirm to a stranger which private paths are there.
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('Not found');
    return;
  }

  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('Not found');
    return;
  }

  const ext = path.extname(file).toLowerCase();
  // Fonts are content-addressed by name and never change; everything else is
  // revalidated so an edit shows up on reload without a hard refresh.
  const cache = ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache';

  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': cache,
    ...SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

/**
 * @param {{ dataFile?: string, coursePath?: string, secureCookies?: boolean,
 *           ownerEmails?: string[] }} [opts]
 */
export async function createServer(opts = {}) {
  const dataFile = opts.dataFile || process.env.FC_DATA || path.join(ROOT, 'data', 'first-commit.json');
  const coursePath = opts.coursePath || path.join(ROOT, 'content', 'course.json');

  const store = new Store(dataFile);
  await store.load();
  const course = JSON.parse(await fsp.readFile(coursePath, 'utf8'));

  const handleApi = createApi({
    store,
    course,
    secureCookies: opts.secureCookies ?? process.env.FC_SECURE_COOKIES === '1',
    ownerEmails: opts.ownerEmails
      ?? String(process.env.FC_OWNER_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean),
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (await handleApi(req, res, url)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, SECURITY_HEADERS);
        res.end('Method not allowed');
        return;
      }
      await serveStatic(req, res, url);
    } catch (err) {
      console.error('server:', err);
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
      res.end('Internal error');
    }
  });

  return { server, store, dataFile };
}

/* --------------------------------- CLI ----------------------------------- */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 8000;
  const { server, store, dataFile } = await createServer();
  server.listen(port, () => {
    console.log(`first-commit  →  http://localhost:${port}`);
    console.log(`data          →  ${dataFile}`);
    if (store.isEmpty()) {
      console.log('\nNo accounts yet. The first account you create becomes the course owner');
      console.log('and is the only one that can open /admin.html.');
    }
  });
}

export default createServer;
