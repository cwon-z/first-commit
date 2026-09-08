/* ============================================================================
 * first-commit — persistence
 * ----------------------------------------------------------------------------
 * One JSON document on disk, written atomically. That is a deliberate choice,
 * not a placeholder: a self-hosted course has tens or hundreds of learners, the
 * whole document is a few hundred kilobytes at that size, and a file the owner
 * can open in an editor and back up with `cp` is worth more here than a
 * database engine and the dependency that comes with it.
 *
 * Every write goes through one promise chain, so concurrent requests queue
 * rather than interleave, and each write lands via write-temp-then-rename so a
 * crash mid-write cannot leave a half-written file where the data used to be.
 *
 * Swap this module if you outgrow it — nothing above it knows it is a file.
 * ========================================================================== */

import fs from 'node:fs/promises';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

const empty = () => ({
  version: SCHEMA_VERSION,
  users: {},      // id -> user record (including the password hash)
  progress: {},   // userId -> progress document
  sessions: {},   // sha256(token) -> { userId, createdAt, expiresAt }
});

export class Store {
  /** @param {string} file path to the JSON document */
  constructor(file) {
    this.file = file;
    this.data = empty();
    this.queue = Promise.resolve();
    this.loaded = false;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.version !== SCHEMA_VERSION) {
        throw new Error(
          `${this.file}: schema version ${parsed.version}, expected ${SCHEMA_VERSION}. ` +
          'Refusing to start rather than silently discarding data — migrate the file first.'
        );
      }
      this.data = { ...empty(), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.data = empty();          // first run: an empty course is normal
      await this.flush();
    }
    this.loaded = true;
    return this.data;
  }

  /** Serialise writes; `fn` mutates `this.data` and may return a value. */
  async write(fn) {
    const run = this.queue.then(async () => {
      const result = await fn(this.data);
      await this.flush();
      return result;
    });
    // Keep the chain alive even when one write rejects, or every later write
    // on this store would reject with the same stale error.
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async flush() {
    const tmp = this.file + '.tmp';
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.rename(tmp, this.file);   // atomic on POSIX and on NTFS
  }

  /* ------------------------------- reads -------------------------------- */

  userById(id) {
    return this.data.users[id] || null;
  }

  userByEmail(email) {
    const key = normaliseEmail(email);
    return Object.values(this.data.users).find((u) => u.email === key) || null;
  }

  listUsers() {
    return Object.values(this.data.users);
  }

  progressFor(userId) {
    return this.data.progress[userId] || null;
  }

  session(tokenHash) {
    return this.data.sessions[tokenHash] || null;
  }

  /** True while nobody has registered — the first account claims ownership. */
  isEmpty() {
    return Object.keys(this.data.users).length === 0;
  }
}

/** Case and whitespace are not identity; two people typing the same address in
 *  different cases are the same person. */
export function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export default Store;
