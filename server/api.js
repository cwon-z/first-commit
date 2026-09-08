/* ============================================================================
 * first-commit — JSON API
 * ----------------------------------------------------------------------------
 *   POST   /api/auth/register     create an account and sign in
 *   POST   /api/auth/login        sign in
 *   POST   /api/auth/logout       sign out
 *   GET    /api/auth/me           who am I (null when signed out)
 *   GET    /api/progress          this account's progress document
 *   PUT    /api/progress          replace it
 *   DELETE /api/progress          clear it
 *   GET    /api/admin/stats       course statistics — owner only
 *
 * The progress document is exactly the shape ui/progress.js already defines, so
 * the client swaps one store for another and nothing above it changes.
 *
 * Cross-site request forgery is blocked twice over: the session cookie is
 * SameSite=Lax, and every mutating route additionally demands a header a plain
 * cross-origin form cannot set.
 * ========================================================================== */

import crypto from 'node:crypto';
import {
  hashPassword, verifyPassword, hashToken, newSessionToken, emailLooksValid,
  passwordProblem, sessionCookie, clearedCookie, readCookie, publicUser,
  RateLimiter, SESSION_DAYS, MIN_PASSWORD,
} from './auth.js';
import { normaliseEmail } from './store.js';
import { buildStats } from './stats.js';

const BODY_LIMIT = 256 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL = 5 * 60 * 1000;   // don't write lastSeenAt on every request
export const REQUEST_HEADER = 'x-first-commit';

const nowIso = () => new Date().toISOString();

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('Body was not valid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/** A progress document we are willing to store, whatever the client sent. */
function sanitiseProgress(input) {
  const lessons = Array.isArray(input?.completedLessons) ? input.completedLessons : [];
  const clean = [...new Set(
    lessons.filter((id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id))
  )].slice(0, 500);
  const last = typeof input?.lastLessonId === 'string' && /^[\w-]{1,64}$/.test(input.lastLessonId)
    ? input.lastLessonId
    : null;
  return { version: 1, completedLessons: clean, lastLessonId: last, updatedAt: nowIso() };
}

const emptyProgress = () => ({ version: 1, completedLessons: [], lastLessonId: null, updatedAt: null });

/**
 * @param {{ store: import('./store.js').Store, course: object, secureCookies?: boolean,
 *           ownerEmails?: string[] }} deps
 */
export function createApi({ store, course, secureCookies = false, ownerEmails = [] }) {
  const loginLimiter = new RateLimiter({ limit: 8, windowMs: 10 * 60 * 1000 });
  const registerLimiter = new RateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });
  const sweeper = setInterval(() => {
    loginLimiter.sweep();
    registerLimiter.sweep();
  }, 10 * 60 * 1000);
  sweeper.unref?.();

  const owners = new Set(ownerEmails.map(normaliseEmail).filter(Boolean));
  const cookieOpts = { secure: secureCookies };

  /** Resolve the caller, expiring the session if it has aged out. */
  async function currentUser(req) {
    const token = readCookie(req.headers.cookie);
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = store.session(tokenHash);
    if (!session) return null;
    if (Date.parse(session.expiresAt) < Date.now()) {
      await store.write((d) => { delete d.sessions[tokenHash]; });
      return null;
    }
    const user = store.userById(session.userId);
    if (!user) return null;

    if (!user.lastSeenAt || Date.now() - Date.parse(user.lastSeenAt) > TOUCH_INTERVAL) {
      await store.write((d) => { d.users[user.id].lastSeenAt = nowIso(); });
    }
    return store.userById(user.id);
  }

  async function startSession(res, userId) {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY).toISOString();
    await store.write((d) => {
      d.sessions[hashToken(token)] = { userId, createdAt: nowIso(), expiresAt };
    });
    res.setHeader('set-cookie', sessionCookie(token, {
      ...cookieOpts, maxAgeSeconds: SESSION_DAYS * 24 * 60 * 60,
    }));
  }

  /* ------------------------------- routes -------------------------------- */

  async function register(req, res, clientKey) {
    const wait = registerLimiter.retryAfter(clientKey);
    if (wait) return json(res, 429, { error: `Too many sign-ups from here. Try again in ${wait}s.` });

    const body = await readBody(req);
    const email = normaliseEmail(body.email);
    if (!emailLooksValid(email)) return json(res, 400, { error: 'That does not look like an email address.' });
    const pwProblem = passwordProblem(body.password);
    if (pwProblem) return json(res, 400, { error: pwProblem });

    const displayName = String(body.displayName || '').trim().slice(0, 60) || email.split('@')[0];

    if (store.userByEmail(email)) {
      registerLimiter.record(clientKey);
      return json(res, 409, { error: 'An account with that address already exists. Sign in instead.' });
    }

    // Whoever sets the course up owns it. After that, ownership is by config
    // only — a stranger who finds the URL becomes a learner, never an owner.
    const owner = store.isEmpty() || owners.has(email);
    const { salt, passwordHash } = await hashPassword(body.password);
    const id = crypto.randomUUID();

    await store.write((d) => {
      d.users[id] = {
        id, email, displayName,
        role: owner ? 'owner' : 'learner',
        salt, passwordHash,
        createdAt: nowIso(), lastSeenAt: nowIso(),
      };
      d.progress[id] = emptyProgress();
    });
    registerLimiter.record(clientKey);
    await startSession(res, id);
    return json(res, 201, { user: publicUser(store.userById(id)) });
  }

  async function login(req, res, clientKey) {
    const body = await readBody(req);
    const email = normaliseEmail(body.email);
    // Rate-limit the pair, so one attacker cannot lock a real learner out.
    const key = clientKey + '|' + email;
    const wait = loginLimiter.retryAfter(key);
    if (wait) return json(res, 429, { error: `Too many attempts. Try again in ${wait}s.` });

    const user = store.userByEmail(email);
    const ok = await verifyPassword(body.password, user);
    if (!user || !ok) {
      loginLimiter.record(key);
      // One message for both cases: a different error for "no such account"
      // would turn this endpoint into a way to enumerate who has signed up.
      return json(res, 401, { error: 'That email and password do not match an account.' });
    }
    loginLimiter.clear(key);
    await store.write((d) => { d.users[user.id].lastSeenAt = nowIso(); });
    await startSession(res, user.id);
    return json(res, 200, { user: publicUser(store.userById(user.id)) });
  }

  async function logout(req, res) {
    const token = readCookie(req.headers.cookie);
    if (token) await store.write((d) => { delete d.sessions[hashToken(token)]; });
    res.setHeader('set-cookie', clearedCookie(cookieOpts));
    return json(res, 200, { ok: true });
  }

  /* ------------------------------ dispatcher ------------------------------ */

  /** @returns {Promise<boolean>} true when the request was an API request. */
  return async function handleApi(req, res, url) {
    if (!url.pathname.startsWith('/api/')) return false;

    const route = url.pathname.slice(5);
    const method = req.method || 'GET';
    const clientKey = req.socket.remoteAddress || 'unknown';

    try {
      // A cross-origin <form> can POST but cannot set a custom header, so this
      // plus SameSite=Lax closes CSRF without a token round-trip.
      if (method !== 'GET' && method !== 'HEAD' && !req.headers[REQUEST_HEADER]) {
        json(res, 403, { error: 'Missing the first-commit request header.' });
        return true;
      }

      if (route === 'auth/register' && method === 'POST') { await register(req, res, clientKey); return true; }
      if (route === 'auth/login' && method === 'POST') { await login(req, res, clientKey); return true; }
      if (route === 'auth/logout' && method === 'POST') { await logout(req, res); return true; }

      if (route === 'auth/me' && method === 'GET') {
        const user = await currentUser(req);
        json(res, 200, {
          user: user ? publicUser(user) : null,
          config: { minPassword: MIN_PASSWORD, needsOwner: store.isEmpty() },
        });
        return true;
      }

      if (route === 'progress') {
        const user = await currentUser(req);
        if (!user) { json(res, 401, { error: 'Sign in first.' }); return true; }

        if (method === 'GET') {
          json(res, 200, { progress: store.progressFor(user.id) || emptyProgress() });
          return true;
        }
        if (method === 'PUT') {
          const body = await readBody(req);
          const doc = sanitiseProgress(body.progress ?? body);
          await store.write((d) => { d.progress[user.id] = doc; });
          json(res, 200, { progress: doc });
          return true;
        }
        if (method === 'DELETE') {
          const doc = emptyProgress();
          await store.write((d) => { d.progress[user.id] = doc; });
          json(res, 200, { progress: doc });
          return true;
        }
      }

      if (route === 'admin/stats' && method === 'GET') {
        const user = await currentUser(req);
        if (!user) { json(res, 401, { error: 'Sign in first.' }); return true; }
        if (user.role !== 'owner') { json(res, 403, { error: 'That page is for the course owner.' }); return true; }
        json(res, 200, buildStats(store, course));
        return true;
      }

      json(res, 404, { error: 'No such endpoint.' });
      return true;
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('api:', err);
      json(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message });
      return true;
    }
  };
}

export default createApi;
