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
  RateLimiter, SESSION_DAYS, MIN_PASSWORD, newToken, tokenIsValid, TOKEN_TTL, clientIp,
} from './auth.js';
import { normaliseEmail } from './store.js';
import { buildStats } from './stats.js';
import { messages } from './mail.js';

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
 * Drop sessions whose expiry has passed.
 *
 * `currentUser` already discards an expired session when it meets one, but a
 * learner who signs in once and never comes back leaves their row behind for
 * good. Nothing breaks; the file just grows for ever. So the server also sweeps
 * on a timer and once at start-up.
 *
 * @returns {Promise<number>} how many were removed
 */
export async function sweepExpiredSessions(store, now = Date.now()) {
  // Collect first, delete inside the write: a session created in between is
  // not in `dead`, so it cannot be swept by accident.
  const dead = Object.entries(store.data.sessions)
    .filter(([, session]) => Date.parse(session.expiresAt) < now)
    .map(([tokenHash]) => tokenHash);
  if (!dead.length) return 0;
  await store.write((d) => { for (const tokenHash of dead) delete d.sessions[tokenHash]; });
  return dead.length;
}

/** Same idea, for the single-use verification and reset tokens. */
export async function sweepExpiredTokens(store, now = Date.now()) {
  const dead = Object.entries(store.data.tokens || {})
    .filter(([, token]) => Date.parse(token.expiresAt) < now)
    .map(([tokenHash]) => tokenHash);
  if (!dead.length) return 0;
  await store.write((d) => { for (const tokenHash of dead) delete d.tokens[tokenHash]; });
  return dead.length;
}

/**
 * @param {{ store: import('./store.js').Store, course: object, secureCookies?: boolean,
 *           ownerEmails?: string[], mailer?: object, baseUrl?: string,
 *           requireVerification?: boolean, brand?: string, mailFrom?: string }} deps
 */
export function createApi({
  store, course, secureCookies = false, ownerEmails = [],
  mailer = null, baseUrl = '', requireVerification = false,
  brand = 'First Commit', mailFrom = 'first-commit@localhost', limits = {},
  trustProxy = 0,
}) {
  /* Sign-ups are limited per client address. A whole classroom can sit behind
     one NAT, so this has to be generous enough not to punish the second half
     of the room while still making bulk account creation pointless. */
  const loginLimiter = new RateLimiter({ limit: limits.login ?? 8, windowMs: 10 * 60 * 1000 });
  const registerLimiter = new RateLimiter({ limit: limits.register ?? 20, windowMs: 60 * 60 * 1000 });
  // Asking for a reset is cheap to request and expensive to receive, so it is
  // limited harder than signing in — otherwise it is a way to have somebody
  // else's inbox filled on demand.
  const resetLimiter = new RateLimiter({ limit: limits.reset ?? 4, windowMs: 60 * 60 * 1000 });
  /* A ceiling on outbound mail for the whole instance.
     Sign-up sends a confirmation to whatever address was typed, so without
     this an open course is a machine for delivering mail to strangers from
     your domain — which costs you your sending reputation, not just noise.
     The per-client limiter alone cannot stop it: the addresses are the
     attacker's to choose and the clients may be many. */
  const mailLimiter = new RateLimiter({ limit: limits.mailPerHour ?? 100, windowMs: 60 * 60 * 1000 });
  const sweeper = setInterval(() => {
    loginLimiter.sweep();
    registerLimiter.sweep();
    resetLimiter.sweep();
    mailLimiter.sweep();
    sweepExpiredSessions(store).catch((err) => console.error('session sweep:', err));
    sweepExpiredTokens(store).catch((err) => console.error('token sweep:', err));
  }, 10 * 60 * 1000);
  sweeper.unref?.();

  const owners = new Set(ownerEmails.map(normaliseEmail).filter(Boolean));
  const cookieOpts = { secure: secureCookies };

  /* --------------------------- token plumbing --------------------------- */

  async function issueToken(kind, userId) {
    const token = newToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL[kind]).toISOString();
    await store.write((d) => {
      // One live token per kind per person: asking again should invalidate the
      // last link, not leave a trail of working ones in an inbox.
      for (const [hash, rec] of Object.entries(d.tokens)) {
        if (rec.kind === kind && rec.userId === userId) delete d.tokens[hash];
      }
      d.tokens[hashToken(token)] = { kind, userId, createdAt: nowIso(), expiresAt };
    });
    return token;
  }

  async function consumeToken(kind, token) {
    if (!token || typeof token !== 'string') return null;
    const tokenHash = hashToken(token);
    const record = store.token(tokenHash);
    if (!tokenIsValid(record, kind)) return null;
    await store.write((d) => { delete d.tokens[tokenHash]; });
    return store.userById(record.userId);
  }

  /** Fire-and-forget: a relay being down must not fail a sign-up. */
  async function deliver(kind, user, token) {
    if (!mailer) return;
    if (mailLimiter.retryAfter('instance')) {
      console.error(
        `mail: hourly cap reached — not sending ${kind} to ${user.email}. ` +
        'If this is real traffic rather than abuse, raise limits.mailPerHour.'
      );
      return;
    }
    mailLimiter.record('instance');
    const link = `${baseUrl}/app.html#/${kind}/${token}`;
    const body = messages[kind]({ brand, name: user.displayName || user.email, link });
    try {
      await mailer.send({ from: mailFrom, to: user.email, ...body });
    } catch (err) {
      console.error(`mail (${kind}) to ${user.email} failed:`, err.message);
    }
  }

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

    /* Who owns the course.
     *
     * If FC_OWNER_EMAILS names anybody, ownership comes from that list and
     * nowhere else. Otherwise the first account to register takes it, which is
     * the convenient thing on a laptop and a genuine hole on a public host: in
     * the window between starting the server and signing up yourself, whoever
     * finds the URL first becomes owner and can read everyone's progress.
     * Deployments must set the variable; index.js says so loudly if they have
     * not, and README documents it. */
    const owner = owners.size ? owners.has(email) : store.isEmpty();
    const { salt, passwordHash } = await hashPassword(body.password);
    const id = crypto.randomUUID();

    await store.write((d) => {
      d.users[id] = {
        id, email, displayName,
        role: owner ? 'owner' : 'learner',
        emailVerified: !mailer,   // nothing to confirm against when mail is off
        salt, passwordHash,
        createdAt: nowIso(), lastSeenAt: nowIso(),
      };
      d.progress[id] = emptyProgress();
    });
    registerLimiter.record(clientKey);

    const created = store.userById(id);
    if (mailer) await deliver('verify', created, await issueToken('verify', id));

    // Even when verification is required, the session starts: the learner
    // should land in the course and see what they are confirming for, not a
    // dead end. `requireVerification` gates the API, not the sign-up.
    await startSession(res, id);
    return json(res, 201, { user: publicUser(created) });
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

  /* ------------------- verification and password reset ------------------- */

  async function verifyEmail(req, res) {
    const body = await readBody(req);
    const user = await consumeToken('verify', body.token);
    if (!user) return json(res, 400, { error: 'That confirmation link has expired or has already been used.' });
    await store.write((d) => { d.users[user.id].emailVerified = true; });
    return json(res, 200, { user: publicUser(store.userById(user.id)) });
  }

  async function resendVerification(req, res) {
    const user = await currentUser(req);
    if (!user) return json(res, 401, { error: 'Sign in first.' });
    if (user.emailVerified !== false) return json(res, 200, { ok: true, alreadyVerified: true });
    if (!mailer) return json(res, 503, { error: 'This server is not set up to send email.' });
    await deliver('verify', user, await issueToken('verify', user.id));
    return json(res, 200, { ok: true });
  }

  async function forgotPassword(req, res, clientKey) {
    const body = await readBody(req);
    const email = normaliseEmail(body.email);
    const wait = resetLimiter.retryAfter(clientKey + '|' + email);
    if (wait) return json(res, 429, { error: `Too many requests. Try again in ${wait}s.` });
    resetLimiter.record(clientKey + '|' + email);

    const user = store.userByEmail(email);
    if (user && mailer) await deliver('reset', user, await issueToken('reset', user.id));

    // Always the same answer. Saying "no such account" here would turn the
    // reset form into a way to find out who has signed up.
    return json(res, 200, {
      ok: true,
      sent: !!mailer,
      message: mailer
        ? 'If that address has an account, a reset link is on its way.'
        : 'This server is not set up to send email — ask the course owner to reset it for you.',
    });
  }

  async function resetPassword(req, res) {
    const body = await readBody(req);
    const problem = passwordProblem(body.password);
    if (problem) return json(res, 400, { error: problem });

    const user = await consumeToken('reset', body.token);
    if (!user) return json(res, 400, { error: 'That reset link has expired or has already been used.' });

    const { salt, passwordHash } = await hashPassword(body.password);
    await store.write((d) => {
      Object.assign(d.users[user.id], { salt, passwordHash });
      // Using the link proves the address; and every other session is dropped,
      // because the usual reason to reset is that somebody else may have one.
      d.users[user.id].emailVerified = true;
      for (const [hash, session] of Object.entries(d.sessions)) {
        if (session.userId === user.id) delete d.sessions[hash];
      }
    });
    await startSession(res, user.id);
    return json(res, 200, { user: publicUser(store.userById(user.id)) });
  }

  async function logout(req, res) {
    const token = readCookie(req.headers.cookie);
    if (token) await store.write((d) => { delete d.sessions[hashToken(token)]; });
    res.setHeader('set-cookie', clearedCookie(cookieOpts));
    return json(res, 200, { ok: true });
  }

  /* --------------------------- your own account -------------------------- */

  /** Everything this server holds about one person, in one file. */
  function exportAccount(user) {
    return {
      exportedAt: nowIso(),
      note: 'Everything first-commit stores about your account. Your password is ' +
        'not here and cannot be: only a scrypt hash of it is stored, and a hash ' +
        'cannot be turned back into the password.',
      account: publicUser(user),
      progress: store.progressFor(user.id) || emptyProgress(),
      activeSessions: Object.values(store.data.sessions)
        .filter((s) => s.userId === user.id)
        .map((s) => ({ createdAt: s.createdAt, expiresAt: s.expiresAt })),
    };
  }

  /** Remove the person: account, progress, sessions and any live tokens. */
  async function forgetUser(userId) {
    await store.write((d) => {
      delete d.users[userId];
      delete d.progress[userId];
      for (const [hash, session] of Object.entries(d.sessions)) {
        if (session.userId === userId) delete d.sessions[hash];
      }
      for (const [hash, token] of Object.entries(d.tokens)) {
        if (token.userId === userId) delete d.tokens[hash];
      }
    });
  }

  /* ------------------------------ dispatcher ------------------------------ */

  /** @returns {Promise<boolean>} true when the request was an API request. */
  return async function handleApi(req, res, url) {
    if (!url.pathname.startsWith('/api/')) return false;

    const route = url.pathname.slice(5);
    const method = req.method || 'GET';
    const clientKey = clientIp(req, trustProxy);

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

      if (route === 'auth/verify' && method === 'POST') { await verifyEmail(req, res); return true; }
      if (route === 'auth/resend-verification' && method === 'POST') { await resendVerification(req, res); return true; }
      if (route === 'auth/forgot' && method === 'POST') { await forgotPassword(req, res, clientKey); return true; }
      if (route === 'auth/reset' && method === 'POST') { await resetPassword(req, res); return true; }

      if (route === 'auth/me' && method === 'GET') {
        const user = await currentUser(req);
        json(res, 200, {
          user: user ? publicUser(user) : null,
          config: {
            minPassword: MIN_PASSWORD,
            needsOwner: !owners.size && store.isEmpty(),
            canSendEmail: !!mailer,
            requireVerification,
          },
        });
        return true;
      }

      if (route === 'account/export' && method === 'GET') {
        const user = await currentUser(req);
        if (!user) { json(res, 401, { error: 'Sign in first.' }); return true; }
        json(res, 200, exportAccount(user), {
          'content-disposition': 'attachment; filename="first-commit-account.json"',
        });
        return true;
      }

      if (route === 'account' && method === 'DELETE') {
        const user = await currentUser(req);
        if (!user) { json(res, 401, { error: 'Sign in first.' }); return true; }
        // The course would become unadministrable, and no confirmation dialog
        // is worth that.
        if (user.role === 'owner' && store.owners().length === 1) {
          json(res, 409, { error: 'You are the only owner. Make someone else an owner first.' });
          return true;
        }
        await forgetUser(user.id);
        res.setHeader('set-cookie', clearedCookie(cookieOpts));
        json(res, 200, { ok: true });
        return true;
      }

      if (route === 'progress') {
        const user = await currentUser(req);
        if (!user) { json(res, 401, { error: 'Sign in first.' }); return true; }
        if (requireVerification && user.emailVerified === false && method !== 'GET') {
          json(res, 403, { error: 'Confirm your email address to save progress.' });
          return true;
        }

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

      if (route.startsWith('admin/')) {
        const caller = await currentUser(req);
        if (!caller) { json(res, 401, { error: 'Sign in first.' }); return true; }
        if (caller.role !== 'owner') {
          json(res, 403, { error: 'That page is for the course owner.' });
          return true;
        }

        if (route === 'admin/stats' && method === 'GET') {
          // The page needs to know who is looking (so it does not offer to
          // delete you) and whether mail works (so it does not offer to resend).
          json(res, 200, { ...buildStats(store, course), viewerId: caller.id, canSendEmail: !!mailer });
          return true;
        }

        const match = /^admin\/users\/([\w-]{1,64})(?:\/(reset-progress|resend-verification))?$/.exec(route);
        if (match) {
          const target = store.userById(match[1]);
          if (!target) { json(res, 404, { error: 'No such learner.' }); return true; }
          const action = match[2];

          if (action === 'reset-progress' && method === 'POST') {
            await store.write((d) => { d.progress[target.id] = emptyProgress(); });
            json(res, 200, { ok: true, progress: emptyProgress() });
            return true;
          }

          if (action === 'resend-verification' && method === 'POST') {
            if (!mailer) { json(res, 503, { error: 'This server is not set up to send email.' }); return true; }
            if (target.emailVerified !== false) { json(res, 200, { ok: true, alreadyVerified: true }); return true; }
            await deliver('verify', target, await issueToken('verify', target.id));
            json(res, 200, { ok: true });
            return true;
          }

          if (!action && method === 'DELETE') {
            // Deleting yourself from here would be a surprising way to lose the
            // course; the account page is where that belongs.
            if (target.id === caller.id) {
              json(res, 409, { error: 'Delete your own account from your account menu, not here.' });
              return true;
            }
            if (target.role === 'owner' && store.owners().length === 1) {
              json(res, 409, { error: 'That is the only owner.' });
              return true;
            }
            await forgetUser(target.id);
            json(res, 200, { ok: true });
            return true;
          }
        }
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
