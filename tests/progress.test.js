/* The browser half of the progress seam, run in Node.
 *
 * ui/progress.js touches nothing but `window.localStorage` and `fetch`, so a
 * Map stands in for the first — one Map shared by every "tab" here, exactly as
 * a browser shares it — and the real server answers the second. What this
 * covers is the one bug a learner cannot forgive: work that was finished and
 * then quietly is not, because another tab, a dropped connection or a pending
 * confirmation got in the way.
 *
 * Run:  node tests/progress.test.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.js';
import { foldProgress as serverFold } from '../server/api.js';
import {
  LocalStorageProgressStore, RestProgressStore, mergeProgress, foldProgress, emptyProgress,
} from '../ui/progress.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) passed++;
  else { failed++; failures.push(name); }
}
const eq = (a, b, name) => ok(a === b, `${name} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const ids = (doc) => JSON.stringify([...doc.completedLessons].sort());

const storage = new Map();
const sharedStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
};
globalThis.window = { localStorage: sharedStorage };

/* ------------------------------ a guest's tabs ----------------------------- */
{
  const tabA = new LocalStorageProgressStore();
  const tabB = new LocalStorageProgressStore();
  let a = await tabA.load();
  let b = await tabB.load();

  a.completedLessons.push('m1l1', 'm1l2');
  a = await tabA.save(a);
  b.lastLessonId = 'm1l3';            // the older tab merely shows a lesson
  b = await tabB.save(b);
  eq(ids(b), '["m1l1","m1l2"]', "a guest's older tab does not erase what another tab finished");
  eq(ids(await new LocalStorageProgressStore().load()), '["m1l1","m1l2"]', 'and the stored copy keeps both');
  eq(b.lastLessonId, 'm1l3', 'while the pointer follows the page last shown');

  const cleared = await tabA.clear();
  ok(typeof cleared.resetAt === 'string', 'a reset is marked, not just deleted');
  const stale = await tabB.save({ ...b, lastLessonId: 'm2l1' });
  eq(stale.completedLessons.length, 0, "the older tab's next save does not undo the reset");
  eq(stale.resetAt, cleared.resetAt, 'and its answer carries the reset for the page to take in');
  const after = await tabB.save({ ...stale, completedLessons: ['m1l1'] });
  eq(ids(after), '["m1l1"]', 'once it has heard of the reset, it saves normally');
}

/* ------------------------- stored before resetAt -------------------------- */
{
  storage.set('first-commit.progress.v1', JSON.stringify({
    version: 1, completedLessons: ['m1l1'], lastLessonId: 'm1l1', updatedAt: null,
  }));
  const legacy = await new LocalStorageProgressStore().load();
  eq(legacy.resetAt, null, 'a copy written by an older build reads as never reset');
  eq(ids(await new LocalStorageProgressStore().save({ ...legacy, completedLessons: ['m1l2'] })),
    '["m1l1","m1l2"]', 'and later saves fold into it');
  storage.clear();
}

/* ---------------------------- storage blocked ------------------------------ */
{
  const refuse = () => { throw new Error('blocked'); };
  globalThis.window = { localStorage: { getItem: refuse, setItem: refuse, removeItem: refuse } };
  const s = new LocalStorageProgressStore();
  const p = await s.load();
  p.completedLessons.push('m1l1');
  await s.save(p);
  eq(ids(await s.load()), '["m1l1"]', 'with storage blocked, progress still holds for the page');
  p.completedLessons.push('m9l9');    // the page's own copy, mutated after saving
  eq(ids(await s.load()), '["m1l1"]', 'and the store keeps its own copy, not a reference to the page\'s');
  globalThis.window = { localStorage: sharedStorage };
}

/* ------------------------------ mergeProgress ------------------------------ */
{
  eq(mergeProgress({ resetAt: 'guest-reset' }, { completedLessons: [] }).resetAt, undefined,
    "a guest's own reset marker never travels into an account");
  eq(mergeProgress({}, { resetAt: 'T' }).resetAt, 'T', "the account's marker does");
  eq(mergeProgress({}, { resetAt: null }).resetAt, null, 'including "never reset"');
}

/* ------------------- the browser and server agree on folding ---------------- */
{
  const cases = [
    [{ completedLessons: ['a'], resetAt: null }, { completedLessons: ['b'], resetAt: null }],
    [{ completedLessons: ['a'], resetAt: 'T' }, { completedLessons: ['b'], resetAt: null }],
    [{ completedLessons: ['a'], resetAt: 'T' }, { completedLessons: ['b'] }],
    [{ completedLessons: ['a'], resetAt: 'T' }, { completedLessons: ['b'], resetAt: 'T' }],
  ];
  for (const [stored, incoming] of cases) {
    const theirs = serverFold({ ...emptyProgress(), ...stored }, { ...emptyProgress(), ...incoming });
    const ours = foldProgress(stored, incoming);
    ok(ids(theirs) === ids(ours) && theirs.resetAt === ours.resetAt,
      `browser and server fold ${JSON.stringify(incoming)} into ${JSON.stringify(stored)} the same way`);
  }
}

/* ----------------------------- signed in: setup ---------------------------- */

const outbox = [];
async function boot(requireVerification) {
  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-progress-')), 'data.json');
  const fx = await createServer({
    dataFile, ownerEmails: ['owner@example.com'], requireVerification, limits: { register: 500 },
    mailer: { name: 'test', async send(m) { outbox.push(m); } },
  });
  await new Promise((r) => fx.server.listen(0, '127.0.0.1', r));
  return { ...fx, base: `http://127.0.0.1:${fx.server.address().port}` };
}

/* The page's relative `./api/…` calls, pointed at a server, with one cookie
   jar — a browser's — and a switch to drop the connection. */
const realFetch = globalThis.fetch;
const net = { base: '', cookie: '', offline: false };
globalThis.fetch = async (url, opts = {}) => {
  if (net.offline) throw new TypeError('Failed to fetch');
  const res = await realFetch(`${net.base}/${String(url).replace(/^[.][/]/, '')}`, {
    ...opts, headers: { ...opts.headers, ...(net.cookie ? { cookie: net.cookie } : null) },
  });
  const set = res.headers.get('set-cookie');
  if (set) net.cookie = set.split(';')[0];
  return res;
};
const api = async (route, body, method = 'POST') => {
  const res = await fetch(`./api/${route}`, {
    method, headers: { 'x-first-commit': '1', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const unsentKey = (user) => `first-commit.unsent.v1.${user.id}`;

/* ------------------------------ an account's tabs --------------------------- */
{
  const fx = await boot(false);
  Object.assign(net, { base: fx.base, cookie: '', offline: false });
  storage.clear();
  const { user } = (await api('auth/register', { email: 'tabs@example.com', password: 'a-long-enough-password' })).body;

  const tabA = new RestProgressStore(user.id);
  const tabB = new RestProgressStore(user.id);
  const a = await tabA.load();
  const b = await tabB.load();
  eq(a.resetAt, null, 'a loaded account copy knows it has never been reset');

  await tabA.save({ ...a, completedLessons: ['m1l1', 'm1l2'], lastLessonId: 'm1l2' });
  const answer = await tabB.save({ ...b, lastLessonId: 'm1l3' });
  eq(ids(answer), '["m1l1","m1l2"]', "an account's older tab does not erase the other's work");
  eq(ids((await api('progress', undefined, 'GET')).body.progress), '["m1l1","m1l2"]', 'on the server either');

  /* Offline: nothing reaches the server, and nothing may be lost. */
  net.offline = true;
  let threw = false;
  try { await tabA.save({ ...answer, completedLessons: [...answer.completedLessons, 'm2l1'] }); }
  catch { threw = true; }
  ok(threw, 'an offline save still reports that it failed');
  ok(storage.has(unsentKey(user)), 'and what it could not send is kept on this device');
  net.offline = false;

  const reopened = await new RestProgressStore(user.id).load();
  ok(reopened.completedLessons.includes('m2l1'), 'reopening the course brings the unsent lesson back');
  const sent = await new RestProgressStore(user.id).save(reopened);
  ok(sent.completedLessons.includes('m2l1'), 'and the next save delivers it');
  ok(!storage.has(unsentKey(user)), 'after which the device copy is gone');

  /* A page whose first copy could not be read at all still saves safely. */
  net.offline = true;
  try { await tabA.save({ ...emptyProgress(), completedLessons: ['m3l1'] }); } catch { /* kept */ }
  net.offline = false;
  const blind = await tabA.save({ ...emptyProgress(), completedLessons: ['m3l2'] });
  eq(ids(blind), '["m1l1","m1l2","m2l1","m3l1","m3l2"]',
    'a save that never knew the account folds in, carrying earlier unsent work with it');

  /* Unsent work from before a reset made elsewhere is the reset's to discard. */
  net.offline = true;
  try { await tabA.save({ ...blind, completedLessons: [...blind.completedLessons, 'm4l1'] }); } catch { /* kept */ }
  net.offline = false;
  const cleared = await tabB.clear();
  ok(typeof cleared.resetAt === 'string' && cleared.completedLessons.length === 0,
    'clearing answers with the reset document');
  const afterReset = await new RestProgressStore(user.id).load();
  eq(afterReset.completedLessons.length, 0, 'work kept from before a reset does not come back after it');
  ok(!storage.has(unsentKey(user)), 'and is dropped');

  /* Two people, one browser: one's unsent work is not the other's. */
  net.offline = true;
  try { await new RestProgressStore(user.id).save({ ...afterReset, completedLessons: ['m5l1'] }); } catch { /* kept */ }
  net.offline = false;
  net.cookie = '';
  const other = (await api('auth/register', { email: 'other@example.com', password: 'a-long-enough-password' })).body.user;
  eq((await new RestProgressStore(other.id).load()).completedLessons.length, 0,
    "another account signing in on this browser does not inherit someone's unsent work");
  ok(storage.has(unsentKey(user)), "which waits for its own account");
  fx.server.close();
}

/* ------------------- confirmation required, and not yet given ---------------- */
{
  const fx = await boot(true);
  Object.assign(net, { base: fx.base, cookie: '', offline: false });
  storage.clear();
  const { user } = (await api('auth/register', { email: 'unconfirmed@example.com', password: 'a-long-enough-password' })).body;
  const tab = new RestProgressStore(user.id);
  const start = await tab.load();

  let status = 0;
  try { await tab.save({ ...start, completedLessons: ['m1l1', 'm1l2'], lastLessonId: 'm1l2' }); }
  catch (err) { status = err.status; }
  eq(status, 403, 'an unconfirmed account is refused a save');
  ok(storage.has(unsentKey(user)), 'but the work is kept on this device instead of vanishing with the tab');

  const token = outbox.find((m) => m.to === 'unconfirmed@example.com').text.match(/#[/]verify[/](\S+)/)[1];
  eq((await api('auth/verify', { token })).status, 200, 'the address is confirmed later');
  const resumed = await new RestProgressStore(user.id).load();
  eq(ids(resumed), '["m1l1","m1l2"]', 'and coming back afterwards brings the earlier work along');
  await new RestProgressStore(user.id).save(resumed);
  eq(ids((await api('progress', undefined, 'GET')).body.progress), '["m1l1","m1l2"]',
    'which the next save puts on the account');
  fx.server.close();
}

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
