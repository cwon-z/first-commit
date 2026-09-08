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
import { RateLimiter, hashPassword, verifyPassword, emailLooksValid } from '../server/auth.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) passed++;
  else { failed++; failures.push(name); }
}
const eq = (a, b, name) => ok(a === b, `${name} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-')), 'data.json');
const { server } = await createServer({ dataFile, secureCookies: false, ownerEmails: [] });
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
  eq(stats.units, 45, 'the denominator matches the shipped course');
  ok(stats.learners.every((l) => !('passwordHash' in l) && !('salt' in l)),
    'the stats never leak a password hash');
  const ownerRow = stats.learners.find((l) => l.email === 'owner@example.com');
  eq(ownerRow.completed, 2, "the owner's completed count is right");
  eq(ownerRow.percent, Math.round((2 / 45) * 100), 'the percentage is computed from the real denominator');
  ok(stats.funnel.length === 45, 'the funnel has a row per unit');
  ok(stats.funnel[0].completed >= 1, 'the funnel counts a completion');
  ok(Array.isArray(stats.modules_) && stats.modules_.length === 11, 'every module is reported');
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

/* ------------------------- the client-side merge --------------------------- */
{
  const local = { completedLessons: ['m1l1', 'm1l2'], lastLessonId: 'm1l2', updatedAt: '2026-01-01T00:00:00.000Z' };
  const remote = { completedLessons: ['m1l2', 'm2l1'], lastLessonId: 'm2l1', updatedAt: '2026-02-01T00:00:00.000Z' };
  const merged = mergeProgress(local, remote);
  eq(merged.completedLessons.length, 3, 'merging keeps every finished lesson from both sides');
  eq(merged.lastLessonId, 'm2l1', 'the newer document wins the "where was I" pointer');
  eq(mergeProgress(remote, local).completedLessons.length, 3, 'merging is symmetric in what it keeps');
}

/* --------------------------------- report --------------------------------- */
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
