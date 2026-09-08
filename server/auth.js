/* ============================================================================
 * first-commit — accounts and sessions
 * ----------------------------------------------------------------------------
 * Passwords are hashed with scrypt and a per-user random salt, and compared in
 * constant time. Sessions are opaque random tokens; only the SHA-256 of a token
 * is stored, so a stolen copy of the data file does not hand over live sessions
 * the way a plaintext token table would.
 *
 * The cookie is HttpOnly (script cannot read it, so an XSS bug cannot exfiltrate
 * the session) and SameSite=Lax (a cross-site form post cannot ride it). Both
 * matter more than usual here, because this app runs learner-typed input all day.
 * ========================================================================== */

import crypto from 'node:crypto';
import { normaliseEmail } from './store.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_DAYS = 30;
export const COOKIE_NAME = 'fc_session';

/* Passwords this short are guessable regardless of hashing; the check belongs
   here rather than in the UI, because the UI is not the security boundary. */
export const MIN_PASSWORD = 10;

const scrypt = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, SCRYPT.keylen, SCRYPT, (err, key) => {
    if (err) reject(err); else resolve(key);
  });
});

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt);
  return { salt, passwordHash: key.toString('hex') };
}

export async function verifyPassword(password, user) {
  if (!user || !user.salt || !user.passwordHash) return false;
  const key = await scrypt(password, user.salt);
  const stored = Buffer.from(user.passwordHash, 'hex');
  if (stored.length !== key.length) return false;
  return crypto.timingSafeEqual(key, stored);
}

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/* --------------------------- single-use tokens ---------------------------- */
/* Email verification and password reset. Same shape as a session — random,
 * stored only as a hash — but short-lived and consumed on first use, because
 * one of them can change a password. */

export const TOKEN_TTL = {
  verify: 24 * 60 * 60 * 1000,   // a day: people confirm addresses when they get to it
  reset: 60 * 60 * 1000,         // an hour: it is the one thing that changes a password
};

export const newToken = () => crypto.randomBytes(32).toString('base64url');

/** A token is only valid if it exists, is the right kind, and has not expired. */
export function tokenIsValid(record, kind, now = Date.now()) {
  if (!record || record.kind !== kind) return false;
  return Date.parse(record.expiresAt) > now;
}

/* ------------------------------- validation ------------------------------- */

/** Deliberately loose. Address validity is proven by delivery, not by regex,
 *  and an over-strict pattern only ever rejects somebody's real address. */
export function emailLooksValid(email) {
  const e = normaliseEmail(email);
  return e.length >= 3 && e.length <= 254 && /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e);
}

export function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (p.length > 200) return 'That is longer than 200 characters.';
  return null;
}

/* ------------------------------ rate limiting ----------------------------- */

/**
 * Fixed-window counter, in memory. It exists to make online password guessing
 * pointless, not to survive a restart — an attacker who can restart the server
 * has already won. Keyed by address *and* client so one attacker cannot lock a
 * real learner out of their own account by failing on purpose.
 */
export class RateLimiter {
  constructor({ limit = 8, windowMs = 10 * 60 * 1000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** @returns {number} seconds to wait, or 0 when the caller may proceed. */
  retryAfter(key, now = Date.now()) {
    const hit = this.hits.get(key);
    if (!hit || now > hit.resetAt) return 0;
    if (hit.count < this.limit) return 0;
    return Math.ceil((hit.resetAt - now) / 1000);
  }

  record(key, now = Date.now()) {
    const hit = this.hits.get(key);
    if (!hit || now > hit.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    hit.count++;
  }

  clear(key) {
    this.hits.delete(key);
  }

  /** Called on a timer so a long-running server does not grow forever. */
  sweep(now = Date.now()) {
    for (const [key, hit] of this.hits) if (now > hit.resetAt) this.hits.delete(key);
  }
}

/* -------------------------------- sessions -------------------------------- */

export function sessionCookie(token, { secure, maxAgeSeconds }) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedCookie({ secure }) {
  return sessionCookie('', { secure, maxAgeSeconds: 0 });
}

export function readCookie(header, name = COOKIE_NAME) {
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The public shape of a user — never the hash, never the salt. */
export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    emailVerified: user.emailVerified !== false,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
  };
}
