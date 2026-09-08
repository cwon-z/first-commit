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
 * Example future implementation:
 *
 *   export class RestProgressStore extends ProgressStore {
 *     constructor(baseUrl, authToken) { ... }
 *     async load()  { return (await fetch(`${this.baseUrl}/api/progress`, ...)).json(); }
 *     async save(p) { await fetch(`${this.baseUrl}/api/progress`, { method: 'PUT', body: JSON.stringify(p), ... }); }
 *   }
 *
 * The progress document schema (versioned so the backend can migrate):
 *   {
 *     version: 1,
 *     completedLessons: string[],   // lesson ids, e.g. "m2l3", "m1-recap"
 *     lastLessonId: string | null,  // where the learner left off
 *     updatedAt: string | null      // ISO timestamp
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

/** Abstract interface. All methods are async so a network impl drops in cleanly. */
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

/** v1: browser localStorage. Safe when storage is unavailable (private mode). */
export class LocalStorageProgressStore extends ProgressStore {
  constructor(key = 'first-commit.progress.v1') {
    super();
    this.key = key;
    this.memoryFallback = emptyProgress(); // used if localStorage is blocked
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

  async load() {
    if (!this.storageAvailable()) return { ...this.memoryFallback };
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) return emptyProgress();
      const parsed = JSON.parse(raw);
      if (parsed.version !== PROGRESS_SCHEMA_VERSION) return emptyProgress(); // future: migrate
      return { ...emptyProgress(), ...parsed };
    } catch {
      return emptyProgress();
    }
  }

  async save(progress) {
    const doc = { ...progress, version: PROGRESS_SCHEMA_VERSION, updatedAt: new Date().toISOString() };
    if (!this.storageAvailable()) { this.memoryFallback = doc; return; }
    try {
      window.localStorage.setItem(this.key, JSON.stringify(doc));
    } catch { /* quota/blocked — degrade silently */ }
  }

  async clear() {
    this.memoryFallback = emptyProgress();
    if (this.storageAvailable()) {
      try { window.localStorage.removeItem(this.key); } catch { /* noop */ }
    }
  }
}
