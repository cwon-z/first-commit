/* Exercises the optional accounts backend end to end over real HTTP.
 *
 * No test framework and no mocks: it boots the actual server against a scratch
 * data file, then talks to it with fetch the way the browser does. The things
 * asserted here are the ones that are quiet when they break — a password
 * comparison that always succeeds, a session that outlives sign-out, one
 * learner reading another's progress, or the stats page opening for anybody.
 *
 * Run:  node tests/server.test.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.js';
import { mergeProgress } from '../ui/progress.js';
import { RateLimiter, hashPassword, verifyPassword, emailLooksValid, clientIp } from '../server/auth.js';
import { sweepExpiredSessions } from '../server/api.js';
import { courseUnits } from '../server/stats.js';

/* The course grows; the denominator is derived from it rather than typed in,
   so adding a lesson does not fail a test that has nothing to do with it. */
const UNITS = courseUnits(JSON.parse(fs.readFileSync('content/course.json', 'utf8')))
  .filter((u) => !u.comingSoon).length;

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) passed++;
  else { failed++; failures.push(name); }
}
const eq = (a, b, name) => ok(a === b, `${name} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-')), 'data.json');

/* A mailer that keeps what it was asked to send, so the tests can follow a
   verification or reset link the way a person would. */
const outbox = [];
const mailer = { name: 'test', async send(message) { outbox.push(message); return { transport: 'test' }; } };
const lastLinkTo = (email) => {
  const message = [...outbox].reverse().find((m) => m.to === email);
  return message && (message.text.match(/https?:[^\s]+/) || [])[0];
};
const tokenIn = (link) => (link || '').split('/').pop();

const { server, store } = await createServer({
  dataFile, secureCookies: false, ownerEmails: [], mailer, baseUrl: 'http://test.local',
  // The suite registers far more accounts from one address than a person would;
  // the limiter itself is covered by its own unit test above.
  limits: { register: 500 },
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** A fetch that keeps its own cookie jar, so each client is a separate browser. */
function client() {
  let cookie = null;
  return async function call(endpoint, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(base + endpoint, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : null),
        ...(cookie ? { cookie } : null),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const value = setCookie.split(';')[0];
      cookie = value.endsWith('=') ? null : value;   // Max-Age=0 clears it
    }
    let json = null;
    try { json = await res.json(); } catch { /* not every response is JSON */ }
    return { status: res.status, body: json, headers: res.headers, setCookie };
  };
}

const H = { 'x-first-commit': '1' };
const post = (call, endpoint, body) => call(endpoint, { method: 'POST', body, headers: H });

/* ------------------------------ hashing ---------------------------------- */
{
  const user = await hashPassword('correct horse battery staple');
  ok(!String(user.passwordHash).includes('correct'), 'the password is not recoverable from the hash');
  ok(await verifyPassword('correct horse battery staple', user), 'the right password verifies');
  ok(!await verifyPassword('correct horse battery stapl', user), 'a near-miss password fails');
  ok(!await verifyPassword('', user), 'an empty password fails');
  const again = await hashPassword('correct horse battery staple');
  ok(again.passwordHash !== user.passwordHash, 'the same password hashes differently (salted)');

  ok(emailLooksValid('a@b.co'), 'a plain address is accepted');
  ok(!emailLooksValid('not-an-address'), 'a bare word is rejected');
  ok(!emailLooksValid('a@b'), 'a dotless domain is rejected');
}

/* --------------------------- rate limiter -------------------------------- */
{
  const rl = new RateLimiter({ limit: 2, windowMs: 1000 });
  eq(rl.retryAfter('k'), 0, 'a fresh key is allowed');
  rl.record('k'); rl.record('k');
  ok(rl.retryAfter('k') > 0, 'the key is blocked once the limit is hit');
  rl.clear('k');
  eq(rl.retryAfter('k'), 0, 'a successful sign-in clears the counter');
}

/* ------------------------------ registration ------------------------------ */
const owner = client();
const learner = client();
{
  const r = await post(owner, '/api/auth/register', {
    email: 'Owner@Example.com', password: 'a-long-enough-password', displayName: 'Owner',
  });
  eq(r.status, 201, 'the first account is created');
  eq(r.body.user.role, 'owner', 'the first account owns the course');
  eq(r.body.user.email, 'owner@example.com', 'the address is stored lower-cased');
  ok(!('passwordHash' in r.body.user) && !('salt' in r.body.user),
    'the API never returns the hash or the salt');
  ok(/HttpOnly/i.test(r.setCookie) && /SameSite=Lax/i.test(r.setCookie),
    'the session cookie is HttpOnly and SameSite=Lax');

  const dup = await post(client(), '/api/auth/register', {
    email: 'owner@example.com', password: 'another-long-password',
  });
  eq(dup.status, 409, 'a duplicate address is refused');

  const short = await post(client(), '/api/auth/register', { email: 'x@y.co', password: 'short' });
  eq(short.status, 400, 'a too-short password is refused');

  const bad = await post(client(), '/api/auth/register', { email: 'nope', password: 'a-long-enough-password' });
  eq(bad.status, 400, 'a malformed address is refused');

  const second = await post(learner, '/api/auth/register', {
    email: 'learner@example.com', password: 'a-long-enough-password', displayName: 'Lee',
  });
  eq(second.status, 201, 'a second account is created');
  eq(second.body.user.role, 'learner', 'the second account is only a learner');
}

/* --------------------------------- CSRF ----------------------------------- */
{
  const r = await owner('/api/progress', {
    method: 'PUT',
    body: { progress: { completedLessons: ['m1l1'] } },
  }); // deliberately no x-first-commit header
  eq(r.status, 403, 'a write without the request header is refused');
}

/* -------------------------------- sign-in --------------------------------- */
{
  const wrong = await post(client(), '/api/auth/login', {
    email: 'owner@example.com', password: 'not-the-password',
  });
  eq(wrong.status, 401, 'the wrong password is refused');

  const unknown = await post(client(), '/api/auth/login', {
    email: 'nobody@example.com', password: 'not-the-password',
  });
  eq(unknown.status, 401, 'an unknown address is refused');
  eq(unknown.body.error, wrong.body.error,
    'unknown address and wrong password give the same message (no user enumeration)');

  const fresh = client();
  const good = await post(fresh, '/api/auth/login', {
    email: 'owner@example.com', password: 'a-long-enough-password',
  });
  eq(good.status, 200, 'the right password signs in');
  const me = await fresh('/api/auth/me');
  eq(me.body.user.email, 'owner@example.com', 'the session identifies the caller');
}

/* -------------------------------- progress -------------------------------- */
{
  const anon = client();
  eq((await anon('/api/progress')).status, 401, 'progress needs a session');

  const saved = await owner('/api/progress', {
    method: 'PUT', headers: H,
    body: { progress: { completedLessons: ['m1l1', 'm1l2', 'm1l1'], lastLessonId: 'm1l2' } },
  });
  eq(saved.status, 200, 'progress saves');
  eq(saved.body.progress.completedLessons.length, 2, 'duplicate lesson ids are collapsed');

  const round = await owner('/api/progress');
  eq(round.body.progress.lastLessonId, 'm1l2', 'progress round-trips');

  const dirty = await owner('/api/progress', {
    method: 'PUT', headers: H,
    body: { progress: { completedLessons: ['ok-id', '../../etc/passwd', 42, '<script>'], lastLessonId: 'x'.repeat(200) } },
  });
  eq(dirty.body.progress.completedLessons.length, 1, 'junk lesson ids are dropped');
  eq(dirty.body.progress.lastLessonId, null, 'an over-long lastLessonId is dropped');

  // The important one: two accounts must not see each other's work.
  await owner('/api/progress', {
    method: 'PUT', headers: H, body: { progress: { completedLessons: ['m1l1', 'm1l2'], lastLessonId: 'm1l2' } },
  });
  const theirs = await learner('/api/progress');
  eq(theirs.body.progress.completedLessons.length, 0,
    "one learner cannot read another's progress");

  await learner('/api/progress', {
    method: 'PUT', headers: H, body: { progress: { completedLessons: ['m1l1'], lastLessonId: 'm1l1' } },
  });
  const stillOwner = await owner('/api/progress');
  eq(stillOwner.body.progress.completedLessons.length, 2, "and cannot overwrite it either");

  const cleared = await learner('/api/progress', { method: 'DELETE', headers: H });
  eq(cleared.body.progress.completedLessons.length, 0, 'progress clears');
  await learner('/api/progress', {
    method: 'PUT', headers: H, body: { progress: { completedLessons: ['m1l1'], lastLessonId: 'm1l1' } },
  });
}

/* ---------------------------------- stats --------------------------------- */
{
  eq((await client()('/api/admin/stats')).status, 401, 'stats need a session');
  eq((await learner('/api/admin/stats')).status, 403, 'a learner cannot read the stats');

  const r = await owner('/api/admin/stats');
  eq(r.status, 200, 'the owner can read the stats');
  const stats = r.body;
  eq(stats.totals.learners, 2, 'both accounts are counted');
  eq(stats.units, UNITS, 'the denominator matches the shipped course');
  ok(stats.learners.every((l) => !('passwordHash' in l) && !('salt' in l)),
    'the stats never leak a password hash');
  const ownerRow = stats.learners.find((l) => l.email === 'owner@example.com');
  eq(ownerRow.completed, 2, "the owner's completed count is right");
  eq(ownerRow.percent, Math.round((2 / UNITS) * 100), 'the percentage is computed from the real denominator');
  eq(stats.funnel.length, UNITS, 'the funnel has a row per unit');
  ok(stats.funnel[0].completed >= 1, 'the funnel counts a completion');
  ok(Array.isArray(stats.modules_) && stats.modules_.length === 11, 'every module is reported');
  eq(stats.viewerId, ownerRow.id, 'the stats say who is looking, so the page does not offer to delete you');
  eq(stats.canSendEmail, true, 'and whether resending a confirmation is possible');
  eq(ownerRow.emailVerified, false, 'confirmation state is reported per learner');
}

/* -------------------------------- sign-out -------------------------------- */
{
  const session = client();
  await post(session, '/api/auth/login', { email: 'learner@example.com', password: 'a-long-enough-password' });
  ok((await session('/api/auth/me')).body.user, 'signed in');
  const out = await post(session, '/api/auth/logout');
  eq(out.status, 200, 'sign-out succeeds');
  eq((await session('/api/auth/me')).body.user, null, 'the session is gone afterwards');
  eq((await session('/api/progress')).status, 401, 'and the token no longer opens progress');
}

/* ------------------------------ static files ------------------------------ */
{
  const anon = client();
  const page = await anon('/app.html');
  eq(page.status, 200, 'the course itself is served');
  ok(/frame-ancestors 'none'/.test(page.headers.get('content-security-policy') || ''),
    'a content security policy is sent');
  eq(page.headers.get('x-content-type-options'), 'nosniff', 'sniffing is disabled');

  eq((await anon('/../package.json')).status, 404, 'a traversal above the root does not escape');
  eq((await anon('/%2e%2e/%2e%2e/etc/passwd')).status, 404, 'an encoded traversal does not escape');
  eq((await anon('/nope.html')).status, 404, 'a missing file is a 404');

  // The three that would actually hurt.
  eq((await anon('/data/first-commit.json')).status, 404,
    'the accounts file — password hashes and session tokens — is not served');
  eq((await anon('/tests/fixtures-solutions.json')).status, 404,
    'the reference solutions are not served (they would spoil every challenge)');
  eq((await anon('/server/store.js')).status, 404, 'the server source is not served');
  eq((await anon('/drafts/module-4.json')).status, 404, 'unpublished drafts are not served');
  eq((await anon('/package.json')).status, 404, 'repository metadata is not served');
  eq((await anon('/.gitattributes')).status, 404, 'dotfiles are not served');

  // …and the ones that must keep working.
  eq((await anon('/')).status, 200, 'the landing page is served at the root');
  eq((await anon('/css/tokens.css')).status, 200, 'stylesheets are served');
  eq((await anon('/ui/app.js')).status, 200, 'the app modules are served');
  eq((await anon('/engine/git-engine.js')).status, 200, 'the engine is served');
  eq((await anon('/content/course.json')).status, 200, 'the course content is served');
  eq((await anon('/assets/fonts/archivo-latin-var.woff2')).status, 200, 'the fonts are served');
  eq((await anon('/admin.html')).status, 200, 'the statistics page is served (the API gates it, not the path)');
}

/* ---------------------------- email verification --------------------------- */
{
  const client_ = client();
  const reg = await post(client_, '/api/auth/register', {
    email: 'verify-me@example.com', password: 'a-really-long-password', displayName: 'Vee',
  });
  eq(reg.status, 201, 'a new account is created');
  eq(reg.body.user.emailVerified, false, 'and starts unverified when mail is configured');

  const link = lastLinkTo('verify-me@example.com');
  ok(link && link.startsWith('http://test.local/app.html#/verify/'), 'a confirmation link is sent');

  const wrong = await post(client_, '/api/auth/verify', { token: 'not-a-real-token' });
  eq(wrong.status, 400, 'a bogus token is refused');

  const done = await post(client_, '/api/auth/verify', { token: tokenIn(link) });
  eq(done.status, 200, 'the link confirms the address');
  eq(done.body.user.emailVerified, true, 'and the account is marked verified');

  const again = await post(client_, '/api/auth/verify', { token: tokenIn(link) });
  eq(again.status, 400, 'the same link cannot be used twice');
}

/* ---------------------------- password reset ------------------------------- */
{
  const before = outbox.length;
  const unknown = await post(client(), '/api/auth/forgot', { email: 'nobody-here@example.com' });
  eq(unknown.status, 200, 'asking to reset an unknown address still answers 200');
  eq(outbox.length, before, 'and sends nothing');

  const asked = await post(client(), '/api/auth/forgot', { email: 'grace-reset@example.com' });
  eq(asked.status, 200, 'asking about a real address answers the same way');

  // now make that account exist and ask properly
  const owner2 = client();
  await post(owner2, '/api/auth/register', { email: 'grace-reset@example.com', password: 'the-first-password' });
  const signedIn = client();
  await post(signedIn, '/api/auth/login', { email: 'grace-reset@example.com', password: 'the-first-password' });
  ok((await signedIn('/api/auth/me')).body.user, 'the old password works before the reset');

  await post(client(), '/api/auth/forgot', { email: 'grace-reset@example.com' });
  const link = lastLinkTo('grace-reset@example.com');
  ok(link && link.includes('#/reset/'), 'a reset link is sent');

  const tooShort = await post(client(), '/api/auth/reset', { token: tokenIn(link), password: 'short' });
  eq(tooShort.status, 400, 'the new password still has to be long enough');

  const fresh = client();
  const reset = await post(fresh, '/api/auth/reset', { token: tokenIn(link), password: 'the-second-password' });
  eq(reset.status, 200, 'the link sets a new password');
  eq(reset.body.user.emailVerified, true, 'and using it proves the address');

  eq((await post(client(), '/api/auth/login', { email: 'grace-reset@example.com', password: 'the-first-password' })).status,
    401, 'the old password stops working');
  eq((await post(client(), '/api/auth/login', { email: 'grace-reset@example.com', password: 'the-second-password' })).status,
    200, 'the new password works');
  eq((await signedIn('/api/auth/me')).body.user, null,
    'every other session is dropped — the usual reason to reset is that someone else has one');
  eq((await post(client(), '/api/auth/reset', { token: tokenIn(link), password: 'a-third-password-x' })).status,
    400, 'the reset link cannot be replayed');
}

/* ------------------------ your own account data ---------------------------- */
{
  const me = client();
  await post(me, '/api/auth/register', { email: 'exporter@example.com', password: 'a-really-long-password' });
  await me('/api/progress', { method: 'PUT', headers: H, body: { progress: { completedLessons: ['m1l1'], lastLessonId: 'm1l1' } } });

  const dump = await me('/api/account/export');
  eq(dump.status, 200, 'you can export your own data');
  eq(dump.body.account.email, 'exporter@example.com', 'the export names the account');
  eq(dump.body.progress.completedLessons.length, 1, 'and carries the progress');
  ok(!JSON.stringify(dump.body).includes('passwordHash'), 'the export contains no password hash');
  ok(!JSON.stringify(dump.body).includes('salt'), 'and no salt');

  const gone = await me('/api/account', { method: 'DELETE', headers: H });
  eq(gone.status, 200, 'you can delete your own account');
  eq((await me('/api/auth/me')).body.user, null, 'and the session ends with it');
  eq((await post(client(), '/api/auth/login', { email: 'exporter@example.com', password: 'a-really-long-password' })).status,
    401, 'the account is really gone');

  const soleOwner = await owner('/api/account', { method: 'DELETE', headers: H });
  eq(soleOwner.status, 409, 'the only owner cannot delete themselves and orphan the course');
}

/* --------------------------- admin write actions --------------------------- */
{
  const victim = client();
  await post(victim, '/api/auth/register', { email: 'resetme@example.com', password: 'a-really-long-password' });
  await victim('/api/progress', { method: 'PUT', headers: H, body: { progress: { completedLessons: ['m1l1', 'm1l2'], lastLessonId: 'm1l2' } } });
  const victimId = (await victim('/api/auth/me')).body.user.id;

  eq((await learner(`/api/admin/users/${victimId}/reset-progress`, { method: 'POST', headers: H })).status,
    403, 'a learner cannot reset somebody else');

  const cleared = await owner(`/api/admin/users/${victimId}/reset-progress`, { method: 'POST', headers: H });
  eq(cleared.status, 200, 'the owner can reset a learner');
  eq((await victim('/api/progress')).body.progress.completedLessons.length, 0, 'and the progress is really gone');

  eq((await owner('/api/admin/users/does-not-exist/reset-progress', { method: 'POST', headers: H })).status,
    404, 'resetting a stranger is a 404');

  const ownerId = (await owner('/api/auth/me')).body.user.id;
  eq((await owner(`/api/admin/users/${ownerId}`, { method: 'DELETE', headers: H })).status,
    409, 'the owner cannot delete themselves from the admin page');

  eq((await learner(`/api/admin/users/${victimId}`, { method: 'DELETE', headers: H })).status,
    403, 'a learner cannot delete anybody');

  const deleted = await owner(`/api/admin/users/${victimId}`, { method: 'DELETE', headers: H });
  eq(deleted.status, 200, 'the owner can delete a learner');
  eq((await victim('/api/auth/me')).body.user, null, "and that learner's session dies with the account");
}

/* ---------------------------- session hygiene ------------------------------ */
{
  const live = Object.keys(store.data.sessions).length;
  await store.write((d) => {
    d.sessions.expired_one = { userId: 'nobody', createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-02-01T00:00:00.000Z' };
    d.sessions.expired_two = { userId: 'nobody', createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-02-01T00:00:00.000Z' };
  });
  const removed = await sweepExpiredSessions(store);
  eq(removed, 2, 'the sweep removes every expired session');
  eq(Object.keys(store.data.sessions).length, live, 'and leaves the live ones alone');
  eq(await sweepExpiredSessions(store), 0, 'a second sweep has nothing to do');
}

/* ------------------------- the client-side merge --------------------------- */
{
  const local = { completedLessons: ['m1l1', 'm1l2'], lastLessonId: 'm1l2', updatedAt: '2026-01-01T00:00:00.000Z' };
  const remote = { completedLessons: ['m1l2', 'm2l1'], lastLessonId: 'm2l1', updatedAt: '2026-02-01T00:00:00.000Z' };
  const merged = mergeProgress(local, remote);
  eq(merged.completedLessons.length, 3, 'merging keeps every finished lesson from both sides');
  eq(merged.lastLessonId, 'm2l1', 'the newer document wins the "where was I" pointer');
  eq(mergeProgress(remote, local).completedLessons.length, 3, 'merging is symmetric in what it keeps');
}

/* --------------------------- who the client is ----------------------------- */
/* Behind a proxy this is the difference between per-visitor rate limiting and
   one shared bucket for the whole internet. */
{
  const req = (xff, socket = '10.0.0.1') => ({
    socket: { remoteAddress: socket },
    headers: xff === null ? {} : { 'x-forwarded-for': xff },
  });

  eq(clientIp(req('203.0.113.9')), '10.0.0.1',
    'the header is ignored unless proxies are declared — otherwise anyone could forge it');
  eq(clientIp(req(null), 1), '10.0.0.1', 'with no header, the socket address is still used');
  eq(clientIp(req('203.0.113.9'), 1), '203.0.113.9', 'one proxy: the client is the only entry');
  eq(clientIp(req('1.1.1.1, 203.0.113.9'), 1), '203.0.113.9',
    'a client that forges an entry is still identified by what the proxy saw');
  eq(clientIp(req('1.1.1.1, 203.0.113.9, 10.9.9.9'), 2), '203.0.113.9',
    'two proxies: count in from the right');
}

/* ----------------------------- mail abuse cap ------------------------------ */
/* Sign-up mails whatever address is typed, so an open course is otherwise a
   machine for delivering mail to strangers from your domain. */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mail-'));
  const sent = [];
  const capped = await createServer({
    dataFile: path.join(dir, 'data.json'),
    ownerEmails: ['boss@example.com'],
    mailer: { name: 'test', async send(m) { sent.push(m); } },
    limits: { register: 500, mailPerHour: 3 },
  });
  await new Promise((r) => capped.server.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${capped.server.address().port}`;
  for (let i = 0; i < 6; i++) {
    await fetch(at + '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...H },
      body: JSON.stringify({ email: `victim${i}@elsewhere.example`, password: 'a-really-long-password' }),
    });
  }
  eq(sent.length, 3, 'outbound mail stops at the instance cap');
  eq(Object.keys(capped.store.data.users).length, 6,
    'and the accounts are still created — mail is best-effort, never a gate');
  capped.server.close();
}

/* --------------------- who owns the course, on a fresh box ----------------- */
/* The bootstrap rule is the one configuration mistake that hands the course to
   a stranger, so it gets its own server. */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-owner-'));
  const configured = await createServer({
    dataFile: path.join(dir, 'data.json'),
    ownerEmails: ['boss@example.com'],
    mailer: { name: 'null', async send() {} },
    limits: { register: 500 },
  });
  await new Promise((r) => configured.server.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${configured.server.address().port}`;
  const call = (endpoint, body) => fetch(at + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', ...H }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const squatter = await call('/api/auth/register', { email: 'first@example.com', password: 'a-really-long-password' });
  eq(squatter.status, 201, 'a stranger may still register');
  eq(squatter.body.user.role, 'learner',
    'but does NOT become owner just by being first, once FC_OWNER_EMAILS is set');

  const boss = await call('/api/auth/register', { email: 'boss@example.com', password: 'a-really-long-password' });
  eq(boss.body.user.role, 'owner', 'the configured address does');
  configured.server.close();
}

/* ------------------------------- migration -------------------------------- */
/* A course that has been running gets upgraded in place; refusing to start, or
   silently dropping people, are both unacceptable answers. */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-migrate-'));
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    users: { u1: { id: 'u1', email: 'old@example.com', displayName: 'Old', role: 'owner', salt: 'x', passwordHash: 'y', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' } },
    progress: { u1: { version: 1, completedLessons: ['m1l1'], lastLessonId: 'm1l1', updatedAt: null } },
    sessions: {},
  }));

  const upgraded = await createServer({ dataFile: file, mailer: { name: 'null', async send() {} } });
  eq(upgraded.store.data.version, 2, 'a v1 document is migrated to v2');
  eq(upgraded.store.userById('u1').emailVerified, true,
    'accounts that predate verification are treated as verified, not locked out');
  eq(upgraded.store.progressFor('u1').completedLessons.length, 1, 'their progress survives');
  ok(upgraded.store.data.tokens && typeof upgraded.store.data.tokens === 'object',
    'the token table is added');
  eq(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2, 'and the migration is written back to disk');
  upgraded.server.close();

  const future = path.join(dir, 'future.json');
  fs.writeFileSync(future, JSON.stringify({ version: 99, users: {}, progress: {}, sessions: {} }));
  let refused = false;
  try { await createServer({ dataFile: future }); } catch { refused = true; }
  ok(refused, 'a document from a newer build is refused rather than downgraded');
}

/* --------------------------------- report --------------------------------- */
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
