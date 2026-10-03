/* ============================================================================
 * first-commit — user progress store
 * ----------------------------------------------------------------------------
 * ★★★ BACKEND SEAM ★★★
 *
 * This module is the single integration point for a future backend.
 * The UI layer talks ONLY to the ProgressStore interface below. Today it is
 * backed by localStorage; to add accounts/server-side progress later,
 * implement the same interface against your REST API and swap the instance
 * created in app.js — no UI changes required.
 *
 * Two implementations ship:
 *
 *   LocalStorageProgressStore  this device only, no account, always available
 *   RestProgressStore          the signed-in account, via the optional server
 *
 * `chooseStore()` at the bottom picks between them, and the app never asks
 * which one it got.
 *
 * The progress document schema (versioned so the backend can migrate):
 *   {
 *     version: 1,
 *     completedLessons: string[],   // lesson ids, e.g. "m2l3", "m1-recap"
 *     lastLessonId: string | null,  // where the learner left off
 *     updatedAt: string | null,     // ISO timestamp
 *     resetAt: string | null        // when progress was last erased. Absent
 *                                   // while a page does not know yet — see
 *                                   // foldProgress
 *   }
 * ========================================================================== */

export const PROGRESS_SCHEMA_VERSION = 1;

export function emptyProgress() {
  return {
    version: PROGRESS_SCHEMA_VERSION,
    completedLessons: [],
    lastLessonId: null,
    updatedAt: null,
  };
}

/**
 * Abstract interface. All methods are async so a network impl drops in cleanly.
 * `save` and `clear` resolve to the document the store now holds, which can
 * carry more than was sent — see foldProgress.
 */
export class ProgressStore {
  /* eslint-disable no-unused-vars */
  async load() { throw new Error('ProgressStore.load not implemented'); }
  async save(progress) { throw new Error('ProgressStore.save not implemented'); }
  async clear() { throw new Error('ProgressStore.clear not implemented'); }
}

/* ---------------------------------------------------------------------------
 * View preferences
 *
 * Not progress, and deliberately not part of the progress document: which
 * workspace layout a learner prefers is a property of the device they are on,
 * not of the account that would one day sync their completions. It lives here
 * anyway so that this module stays the ONE place that talks to storage.
 * ------------------------------------------------------------------------- */

export const DEFAULT_PREFS = { layout: 'split' };

/** Synchronous by design — the shell reads it while painting the first frame. */
export class LocalStoragePrefsStore {
  constructor(key = 'first-commit.prefs.v1') {
    this.key = key;
    this.memoryFallback = { ...DEFAULT_PREFS };
  }

  load() {
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) return { ...this.memoryFallback };
      return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
    } catch {
      return { ...this.memoryFallback };
    }
  }

  save(prefs) {
    const doc = { ...DEFAULT_PREFS, ...prefs };
    this.memoryFallback = doc;
    try {
      window.localStorage.setItem(this.key, JSON.stringify(doc));
    } catch { /* private mode, quota, blocked — the in-memory copy still holds */ }
  }
}

/**
 * Fold a copy a page wants to save into the one already stored.
 *
 * Saving used to overwrite. Every open tab saves its whole copy each time it
 * shows a lesson, so a tab left open on an old copy erased whatever another tab
 * had finished since. Completions now only accumulate, except across a reset:
 * `resetAt` marks when progress was last erased, and a copy from before that
 * gets the reset rather than putting its old list back. A copy with no
 * `resetAt` does not know which side of a reset it is on, and is folded in as
 * current. server/api.js applies the same rule to an account's document.
 */
export function foldProgress(stored, incoming) {
  const next = { ...emptyProgress(), ...incoming };
  const updatedAt = new Date().toISOString();
  if (!stored) {
    return {
      ...next,
      version: PROGRESS_SCHEMA_VERSION,
      completedLessons: [...new Set(next.completedLessons)],
      updatedAt,
      resetAt: next.resetAt ?? null,
    };
  }
  const base = { ...emptyProgress(), resetAt: null, ...stored };
  const stale = next.resetAt !== undefined && next.resetAt !== base.resetAt;
  return {
    version: PROGRESS_SCHEMA_VERSION,
    completedLessons: stale
      ? [...base.completedLessons]
      : [...new Set([...base.completedLessons, ...next.completedLessons])],
    lastLessonId: next.lastLessonId || base.lastLessonId,
    updatedAt,
    resetAt: base.resetAt,
  };
}

/** v1: browser localStorage. Safe when storage is unavailable (private mode). */
export class LocalStorageProgressStore extends ProgressStore {
  constructor(key = 'first-commit.progress.v1') {
    super();
    this.key = key;
    this.memoryFallback = null; // used if localStorage is blocked
  }

  storageAvailable() {
    try {
      const t = '__fc_test__';
      window.localStorage.setItem(t, t);
      window.localStorage.removeItem(t);
      return true;
    } catch {
      return false;
    }
  }

  /** The stored document, or null when there is none worth reading. */
  read() {
    if (!this.storageAvailable()) {
      const m = this.memoryFallback;
      return m ? { ...m, completedLessons: [...m.completedLessons] } : null;
    }
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed.version !== PROGRESS_SCHEMA_VERSION) return null; // future: migrate
      // A stored copy knows its generation: one written before `resetAt`
      // existed has never been reset since.
      return { ...emptyProgress(), resetAt: null, ...parsed };
    } catch {
      return null;
    }
  }

  write(doc) {
    if (!this.storageAvailable()) { this.memoryFallback = doc; return; }
    try {
      window.localStorage.setItem(this.key, JSON.stringify(doc));
    } catch { /* quota/blocked — degrade silently */ }
  }

  async load() {
    return this.read() || emptyProgress();
  }

  async save(progress) {
    const doc = foldProgress(this.read(), progress);
    this.write(doc);
    return doc;
  }

  /** Not a deletion: the marker is what stops another open tab undoing it. */
  async clear() {
    const now = new Date().toISOString();
    const doc = { ...emptyProgress(), updatedAt: now, resetAt: now };
    this.write(doc);
    return doc;
  }
}

/* ---------------------------------------------------------------------------
 * v2: the optional server
 *
 * Identical interface, so app.js cannot tell the difference. Reads and writes
 * go to the signed-in account, which is what makes progress follow a learner
 * from their phone to their laptop.
 * ------------------------------------------------------------------------- */

/** Custom header the API demands on writes; a cross-site form cannot set it. */
export const REQUEST_HEADER = 'x-first-commit';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Relative by design (`./api/…`), so the app still works served from a
 * subdirectory. `credentials: same-origin` carries the session cookie.
 */
export async function apiFetch(endpoint, options = {}) {
  const res = await fetch(`./api/${endpoint}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      [REQUEST_HEADER]: '1',
      ...(options.body ? { 'content-type': 'application/json' } : null),
      ...options.headers,
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty or not JSON */ }
  if (!res.ok) throw new ApiError(body?.error || `HTTP ${res.status}`, res.status);
  return body;
}

/** Whether two copies can be combined: one of them does not know, or they agree. */
const sameGeneration = (a, b) =>
  a.resetAt === undefined || b.resetAt === undefined || a.resetAt === b.resetAt;

/**
 * What a signed-in page tried to save and could not.
 *
 * It used to exist only in the open page, so a learner who was offline, whose
 * session had ended, or who had not confirmed their address yet lost all of it
 * the moment they closed the tab. It is kept on this device under the
 * account's id — never in the guest's copy, which another account on this
 * browser would inherit — and goes with the next save, or the next sign-in to
 * that account, that gets through.
 */
class UnsentProgress {
  constructor(userId) {
    this.key = `first-commit.unsent.v1.${userId}`;
  }

  /** @returns {{ doc: object, raw: string } | null} */
  read() {
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) return null;
      const doc = JSON.parse(raw);
      return doc && doc.version === PROGRESS_SCHEMA_VERSION ? { doc: { ...emptyProgress(), ...doc }, raw } : null;
    } catch {
      return null;
    }
  }

  keep(doc) {
    const prev = this.read();
    let next = doc;
    if (prev && sameGeneration(prev.doc, doc)) {
      next = mergeProgress(prev.doc, doc);
      next.lastLessonId = doc.lastLessonId || next.lastLessonId;
      if (next.resetAt === undefined && prev.doc.resetAt !== undefined) next.resetAt = prev.doc.resetAt;
    }
    try {
      window.localStorage.setItem(this.key, JSON.stringify(next));
    } catch { /* storage blocked: the open page still holds it */ }
  }

  /** Drop it once sent — unless another tab has added to it since `seen` was read. */
  forget(seen) {
    try {
      const raw = window.localStorage.getItem(this.key);
      if (raw !== null && (seen === undefined || raw === seen)) window.localStorage.removeItem(this.key);
    } catch { /* nothing to drop */ }
  }
}

export class RestProgressStore extends ProgressStore {
  /** @param {string} [userId] the account; names the device's copy of anything unsent */
  constructor(userId) {
    super();
    this.unsent = userId ? new UnsentProgress(userId) : null;
  }

  async load() {
    const body = await apiFetch('progress');
    const remote = { ...emptyProgress(), ...body.progress };
    const unsent = this.unsent && this.unsent.read();
    if (!unsent) return remote;
    // Kept from before a reset made somewhere else: the reset wins.
    if (!sameGeneration(unsent.doc, remote)) {
      this.unsent.forget(unsent.raw);
      return remote;
    }
    return mergeProgress(unsent.doc, remote);
  }

  async save(progress) {
    const unsent = this.unsent && this.unsent.read();
    let doc = { ...progress, version: PROGRESS_SCHEMA_VERSION };
    if (unsent && sameGeneration(unsent.doc, doc)) {
      doc = { ...mergeProgress(unsent.doc, doc), lastLessonId: doc.lastLessonId || unsent.doc.lastLessonId };
    }
    let body;
    try {
      body = await apiFetch('progress', { method: 'PUT', body: JSON.stringify({ progress: doc }) });
    } catch (err) {
      if (this.unsent) this.unsent.keep(doc);
      throw err;
    }
    // Sent with this save, or from before a reset this page already knows of.
    if (unsent) this.unsent.forget(unsent.raw);
    return body && body.progress ? { ...emptyProgress(), ...body.progress } : null;
  }

  async clear() {
    const body = await apiFetch('progress', { method: 'DELETE' });
    if (this.unsent) this.unsent.forget();
    return body && body.progress ? { ...emptyProgress(), ...body.progress } : emptyProgress();
  }
}

/**
 * Ask the server who we are. Resolves to null when there is no server at all —
 * which is the normal case for the static deployment, not an error.
 */
export async function probeSession() {
  try {
    return await apiFetch('auth/me');
  } catch {
    return null;
  }
}

/**
 * Signed in → the account. Otherwise → this device.
 *
 * A guest still gets saved progress; signing in later merges it up rather than
 * throwing it away, which is why `mergeProgress` exists.
 */
export function chooseStore(session) {
  return session && session.user
    ? new RestProgressStore(session.user.id)
    : new LocalStorageProgressStore();
}

/**
 * Union of two progress documents. Completing a lesson is not something that
 * can be undone by syncing, so a lesson finished in either place stays finished;
 * only the "where was I" pointer has to pick a winner, and the newer one wins.
 */
export function mergeProgress(a, b) {
  const left = { ...emptyProgress(), ...a };
  const right = { ...emptyProgress(), ...b };
  const newer = (Date.parse(right.updatedAt || 0) || 0) >= (Date.parse(left.updatedAt || 0) || 0)
    ? right : left;
  const merged = {
    version: PROGRESS_SCHEMA_VERSION,
    completedLessons: [...new Set([...left.completedLessons, ...right.completedLessons])],
    lastLessonId: newer.lastLessonId || left.lastLessonId || right.lastLessonId,
    updatedAt: newer.updatedAt,
  };
  // The reset marker is the second document's alone. Every caller passes the
  // account's copy second, and a guest's own marker means nothing to the server.
  if (right.resetAt !== undefined) merged.resetAt = right.resetAt;
  return merged;
}
