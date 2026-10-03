/* Real HTTP regressions for malformed input and overlapping account writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../server/index.js';

const outbox = [];
const { server, store } = await createServer({
  dataFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-adversarial-')), 'data.json'),
  ownerEmails: [], mailer: { async send(m) { outbox.push(m); } },
  limits: { register: 500, login: 500 },
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const password = 'sweep-password-123';
const call = async (route, body, cookie, method = 'POST') => {
  const response = await fetch(base + '/api/' + route, {
    method, headers: { 'x-first-commit': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
};
// Hold the first two writes until both requests reach the transaction boundary.
// This makes races reproducible without timing assumptions about disk or scrypt.
async function overlap(a, b) {
  const original = store.write.bind(store);
  let release, count = 0;
  const barrier = new Promise(r => { release = r; });
  store.write = async fn => {
    if (++count <= 2) { if (count === 2) release(); await barrier; }
    return original(fn);
  };
  try { return await Promise.all([a(), b()]); }
  finally { store.write = original; }
}
const failures = [];
async function test(name, run) {
  try { await run(); console.log('PASS ' + name); }
  catch (err) { failures.push(name); console.error('FAIL ' + name + ': ' + err.message); }
}
try {
  await test('simultaneous first registrations create only one owner', async () => {
    const results = await overlap(
      () => call('auth/register', { email: 'first@sweep.example', password }),
      () => call('auth/register', { email: 'second@sweep.example', password }));
    assert.deepEqual(results.map(r => r.status), [201, 201]);
    assert.equal(store.owners().length, 1);
  });
  await test('simultaneous duplicate registration creates only one account', async () => {
    const results = await overlap(
      () => call('auth/register', { email: 'duplicate@sweep.example', password }),
      () => call('auth/register', { email: 'DUPLICATE@sweep.example', password }));
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal(store.listUsers().filter(u => u.email === 'duplicate@sweep.example').length, 1);
  });
  const learner = await call('auth/register', { email: 'learner@sweep.example', password });
  await test('JSON must be an object on every body-reading route', async () => {
    for (const route of ['auth/register', 'auth/login', 'auth/forgot', 'auth/verify', 'auth/reset', 'progress']) {
      for (const body of [null, [], 'text', 123, true]) {
        const r = await call(route, body, learner.cookie, route === 'progress' ? 'PUT' : 'POST');
        assert.equal(r.status, 400, route + ': ' + JSON.stringify(body));
      }
    }
  });
  await test('passwords and email addresses must be strings', async () => {
    for (const value of [null, {}, ['sweep-password-123'], 1234567890123]) {
      assert.equal((await call('auth/register', { email: 'bad@sweep.example', password: value })).status, 400);
      assert.equal((await call('auth/login', { email: 'learner@sweep.example', password: value })).status, 401);
    }
    assert.equal((await call('auth/register', { email: ['array@sweep.example'], password })).status, 400);
  });
  await test('oversized JSON returns a readable 413 response', async () => {
    assert.equal((await call('auth/register', { padding: 'x'.repeat(270000) })).status, 413);
  });
  await call('auth/forgot', { email: 'learner@sweep.example' });
  const token = outbox.at(-1).text.match(/#\/reset\/(\S+)/)[1];
  await test('one reset token cannot succeed in two concurrent requests', async () => {
    const results = await overlap(
      () => call('auth/reset', { token, password: 'new-password-one' }),
      () => call('auth/reset', { token, password: 'new-password-two' }));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  });
  await test('private paths stay private after decoding', async () => {
    for (const p of ['/data/first-commit.json', '/tests/fixtures-solutions.json', '/drafts/module-1.json',
      '/ui/%2e%2e%2fdata/first-commit.json', '/ui/..%5cdata/first-commit.json', '/%64ata/first-commit.json', '/ui/%252e%252e/data/first-commit.json']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
  });
  await test('expired and wrong-kind tokens cannot change passwords', async () => {
    const verified = await call('auth/register', {email:'tokens@sweep.example',password});
    const verification = outbox.at(-1).text.match(/#\/verify\/(\S+)/)[1];
    assert.equal((await call('auth/reset',{token:verification,password})).status,400);
    assert.equal((await call('auth/verify',{token:verification})).status,200);
    await call('auth/forgot',{email:'tokens@sweep.example'});
    const reset = outbox.at(-1).text.match(/#\/reset\/(\S+)/)[1];
    assert.equal((await call('auth/verify',{token:reset})).status,400);
    await store.write(d => { for (const token of Object.values(d.tokens)) {
      if (token.userId === verified.body.user.id) token.expiresAt = '2000-01-01T00:00:00Z';
    } });
    assert.equal((await call('auth/reset',{token:reset,password})).status,400);
  });
  await test('deleting an account revokes both browser sessions', async () => {
    const a = await call('auth/register',{email:'two-sessions@sweep.example',password});
    const b = await call('auth/login',{email:'two-sessions@sweep.example',password});
    assert.equal((await call('account',{},a.cookie,'DELETE')).status,200);
    assert.equal((await call('progress',null,a.cookie,'GET')).status,401);
    assert.equal((await call('progress',null,b.cookie,'GET')).status,401);
  });
  await test('malformed request targets return 400 without crashing', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(base, { path: 'http://[' }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('No response to malformed URL')));
    });
    assert.equal(status, 400);
    assert.equal((await fetch(base + '/app.html')).status, 200);
  });
  await test('a static file that cannot be opened does not take the server down', async () => {
    // Passes the stat, fails the open: what a deploy removing the file in
    // between, a wrong permission, or running out of descriptors looks like.
    const realOpen = fs.createReadStream;
    fs.createReadStream = (file, ...rest) => String(file).endsWith('index.html')
      ? realOpen(path.join(os.tmpdir(), `fc-missing-${process.pid}-${Date.now()}`), ...rest)
      : realOpen(file, ...rest);
    try { await fetch(base + '/index.html').then(r => r.text()).catch(() => {}); }
    finally { fs.createReadStream = realOpen; }
    assert.equal((await fetch(base + '/app.html')).status, 200);
  });
  await test('parallel requests cannot bypass sign-up and login rate limits', async () => {
    const limited = await createServer({
      dataFile:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'fc-burst-')),'data.json'),
      ownerEmails:['owner@sweep.example'], mailer:{async send(){}},
      secureCookies:true, trustProxy:1, limits:{register:1,login:1},
    });
    await new Promise(r=>limited.server.listen(0,'127.0.0.1',r));
    const at = 'http://127.0.0.1:' + limited.server.address().port;
    const post = (route, body, ip='203.0.113.1') => fetch(at+'/api/auth/'+route,{
      method:'POST',headers:{'x-first-commit':'1','content-type':'application/json','x-forwarded-for':'forged, '+ip},
      body:JSON.stringify(body),
    });
    try {
      const reg = await Promise.all([0,1,2,3].map(i=>post('register',{email:'burst'+i+'@sweep.example',password})));
      assert.deepEqual(reg.map(r=>r.status).sort(),[201,429,429,429]);
      const accepted = reg.find(r=>r.status===201);
      assert.match(accepted.headers.get('set-cookie'),/; Secure/);
      const user = (await accepted.json()).user;
      const logins = await Promise.all([0,1,2,3].map(()=>post('login',{email:user.email,password:'wrong-password'})));
      assert.deepEqual(logins.map(r=>r.status).sort(),[401,429,429,429]);
      assert.equal((await post('login',{email:user.email,password},'203.0.113.2')).status,200);
      assert.match((await post('logout',{})).headers.get('set-cookie'),/; Secure/);
    } finally { await new Promise(r=>limited.server.close(r)); }
  });
} finally {
  await new Promise(r => server.close(r));
}
if (failures.length) process.exitCode = 1;
