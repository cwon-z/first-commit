/* ============================================================================
 * first-commit — persistence
 * ----------------------------------------------------------------------------
 * One JSON document on disk, written atomically. That is a deliberate choice,
 * not a placeholder: a file the owner can open in an editor and back up with
 * `cp` is worth more here than a database engine and the dependency it drags in.
 *
 * The cost is that every write rewrites the whole document, so it is linear in
 * the number of accounts. Measured, with each learner carrying progress and a
 * live session:
 *
 *      100 users   0.08 MB    0.9 ms per progress save
 *    1,000 users   0.82 MB    2.5 ms
 *    5,000 users   4.13 MB   10.3 ms
 *
 * Writes are serialised, so 5,000 accounts still leaves headroom of roughly a
 * hundred saves a second — far more than a course generates. Comfortable to a
 * few thousand; past that, this module is the thing to replace, and nothing
 * above it needs to know.
 *
 * Every write goes through one promise chain, so concurrent requests queue
 * rather than interleave, and each write lands via write-temp-then-rename so a
 * crash mid-write cannot leave a half-written file where the data used to be.
 *
 * Swap this module if you outgrow it — nothing above it knows it is a file.
 * ========================================================================== */

import fs from 'node:fs/promises';
import path from 'node:path';

export const SCHEMA_VERSION = 2;

const empty = () => ({
  version: SCHEMA_VERSION,
  users: {},      // id -> user record (including the password hash)
  progress: {},   // userId -> progress document
  sessions: {},   // sha256(token) -> { userId, createdAt, expiresAt }
  tokens: {},     // sha256(token) -> { kind, userId, createdAt, expiresAt }
});

/**
 * Bring an older document forward. Refusing to start would be safe but useless
 * — it would strand a running course on an upgrade — so every version this
 * server has ever written has a path to the current one.
 *
 * v1 → v2  adds the single-use token table (email verification, password
 *          reset) and an `emailVerified` flag. Accounts that predate
 *          verification are marked verified: they were created when the
 *          server did not ask, and locking them out now would punish people
 *          for our change.
 */
function migrate(doc) {
  const out = { ...empty(), ...doc };
  if (!doc.version || doc.version < 2) {
    out.tokens = out.tokens || {};
    for (const user of Object.values(out.users)) {
      if (user.emailVerified === undefined) user.emailVerified = true;
    }
  }
  out.version = SCHEMA_VERSION;
  return out;
}

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
      if (parsed.version > SCHEMA_VERSION) {
        throw new Error(
          `${this.file}: schema version ${parsed.version}, but this server writes ${SCHEMA_VERSION}. ` +
          'It was written by a newer build — refusing to start rather than downgrading your data.'
        );
      }
      const migrated = parsed.version !== SCHEMA_VERSION;
      this.data = migrate(parsed);
      if (migrated) await this.flush();
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

  token(tokenHash) {
    return this.data.tokens[tokenHash] || null;
  }

  owners() {
    return this.listUsers().filter((u) => u.role === 'owner');
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
