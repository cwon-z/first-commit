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
 *   npm start                    http://localhost:8000
 *   PORT=3000                    port to listen on
 *   FC_DATA=./data/fc.json       where the JSON document lives
 *   FC_OWNER_EMAILS=a@b.com      who owns the course. SET THIS IN PRODUCTION:
 *                                without it the first stranger to register
 *                                becomes the owner.
 *   FC_BASE_URL=https://x.com    public origin, used to build email links
 *   FC_SMTP_URL=smtps://u:p@h    send real email; omit to write to data/outbox
 *   FC_MAIL_FROM=course@x.com    envelope sender
 *   FC_REQUIRE_VERIFICATION=1    unconfirmed accounts cannot save progress
 *   FC_SECURE_COOKIES=1          set behind HTTPS
 *
 * Every one of these is configuration, not a secret in the repository. That is
 * what lets this be a public mirror of what is deployed.
 * ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { createApi, sweepExpiredSessions, sweepExpiredTokens } from './api.js';
import { createTransport } from './mail.js';

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
  // A server that was down for a month comes back with a month of dead
  // sessions; clear them before serving rather than on a timer 10 minutes in.
  await sweepExpiredSessions(store);
  await sweepExpiredTokens(store);
  const course = JSON.parse(await fsp.readFile(coursePath, 'utf8'));

  const ownerEmails = opts.ownerEmails
    ?? String(process.env.FC_OWNER_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const port = Number(opts.port ?? process.env.PORT) || 8000;
  const baseUrl = (opts.baseUrl ?? process.env.FC_BASE_URL ?? `http://localhost:${port}`)
    .replace(/[/]+$/, '');
  const smtpUrl = opts.smtpUrl ?? process.env.FC_SMTP_URL ?? '';

  const mailer = opts.mailer ?? createTransport({
    smtpUrl,
    outbox: path.join(path.dirname(dataFile), 'outbox'),
  });

  const handleApi = createApi({
    store,
    course,
    mailer,
    baseUrl,
    brand: course.meta?.brand || 'First Commit',
    mailFrom: opts.mailFrom ?? process.env.FC_MAIL_FROM ?? 'first-commit@localhost',
    requireVerification: opts.requireVerification
      ?? process.env.FC_REQUIRE_VERIFICATION === '1',
    secureCookies: opts.secureCookies ?? process.env.FC_SECURE_COOKIES === '1',
    ownerEmails,
    limits: opts.limits,
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

  return { server, store, dataFile, mailer, baseUrl, ownerEmails, port };
}

/* --------------------------------- CLI ----------------------------------- */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server, store, dataFile, mailer, baseUrl, ownerEmails, port } = await createServer();
  server.listen(port, () => {
    console.log(`first-commit  →  ${baseUrl}`);
    console.log(`data          →  ${dataFile}`);
    console.log(`mail          →  ${mailer.name === 'smtp' ? `smtp ${mailer.host}` : 'written to data/outbox (no SMTP configured)'}`);

    /* The one configuration mistake that actually hands the course away.
       Without FC_OWNER_EMAILS the first registration wins, so on a public
       host the window between `npm start` and your own sign-up is a race
       anybody who finds the URL can win. */
    if (!ownerEmails.length) {
      if (store.isEmpty()) {
        console.warn('\n  ⚠  UNCLAIMED. No owner is configured and no account exists, so the');
        console.warn('     first person to register becomes the course owner and can read');
        console.warn('     everyone\'s progress.');
        console.warn('     On anything reachable from the internet, stop and set');
        console.warn('     FC_OWNER_EMAILS=you@example.com before going further.\n');
      } else {
        console.log('\nowner         →  claimed by the first account (FC_OWNER_EMAILS is not set)');
      }
    } else {
      console.log(`owner         →  ${ownerEmails.join(', ')}`);
    }
  });
}

export default createServer;
