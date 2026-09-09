/* Interaction sweep — the defects the other tests structurally cannot see.
 *
 * tests/ui.test.js reads the source as text. It can prove an element exists and
 * that a module references it; it cannot prove that pressing a button does
 * anything. That gap is not theoretical: a submit button rendered outside its
 * <form> shipped once, looked perfect, and did nothing at all.
 *
 * So this drives a real browser against a real server over the DevTools
 * protocol and, for every route and every dialog, reports:
 *
 *   dead controls   a button or link with no handler anywhere up the tree,
 *                   a submit button belonging to no form, a link with no href
 *   accessibility   duplicate ids, unlabelled inputs, buttons with no
 *                   accessible name, aria-* pointing at elements that are gone
 *   console         any error, warning or uncaught exception on the page
 *
 * Not part of `npm test`: it needs Chrome and a running server, and CI has
 * neither. Run it before a deploy.
 *
 *   npm start                        # in another terminal
 *   node tools/sweep.mjs             # against http://127.0.0.1:8000
 *   node tools/sweep.mjs http://localhost:3000
 *   node tools/sweep.mjs --accounts  # isolated server + real account interactions
 *   node tools/sweep.mjs http://localhost:8000 --static
 * --accounts never writes to the supplied URL; it creates its own scratch server.
 * Requires Node 22+ for the tooling's built-in WebSocket; the app/server need 18+.
 *
 * Exits non-zero if anything is found, so it can gate a deploy script.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.js';
import { sweepFlows } from './sweep-flows.mjs';

let BASE = (process.argv.slice(2).find(a => !a.startsWith('--')) || process.env.FC_SWEEP_BASE || 'http://127.0.0.1:8000').replace(/[/]+$/, '');
const accounts = process.argv.includes('--accounts');
const staticOnly = process.argv.includes('--static');
const outbox = [];
let fixture;
if (accounts) {
  fixture = await createServer({
    dataFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sweep-data-')), 'data.json'),
    ownerEmails: ['owner@sweep.example'], secureCookies: false, requireVerification: false, trustProxy: 0,
    mailer: { async send(m) { outbox.push(m); } }, limits: { register: 500 },
  });
  await new Promise(r => fixture.server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + fixture.server.address().port;
}
const PORT = Number(process.env.FC_SWEEP_CDP_PORT) || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ find a browser ---------------------------- */

const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

const chrome = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!chrome) {
  console.error('sweep: no Chrome or Chromium found. Set CHROME=/path/to/chrome.');
  process.exit(2);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sweep-'));
const browser = spawn(chrome, [
  '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  'about:blank',
], { stdio: 'ignore' });

const stop = () => { try { browser.kill(); fixture?.server.close(); } catch { /* already gone */ } };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

/* -------------------------------- connect --------------------------------- */

let targets = null;
for (let i = 0; i < 80; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    if (targets.some((t) => t.type === 'page')) break;
  } catch { /* not listening yet */ }
  await sleep(250);
}
const target = targets && targets.find((t) => t.type === 'page');
if (!target) { console.error('sweep: the browser never came up'); stop(); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
let consoleLog = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) {
    consoleLog.push(`[${msg.params.entry.level}] ${msg.params.entry.text} ${msg.params.entry.url || ''}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    consoleLog.push('[' + msg.params.type + '] ' + msg.params.args.map(a => a.value || a.description || '').join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    consoleLog.push(`[exception] ${d.text} ${d.exception?.description || ''}`);
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (expression, cli = false) => {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: cli,
  });
  if (r.error || r.result?.exceptionDetails) throw new Error(JSON.stringify(r.error || r.result.exceptionDetails));
  return r.result?.result?.value;
};

await send('Log.enable');
await send('Runtime.enable');

/* --------------------------------- probes --------------------------------- */

/* getEventListeners() exists only in the DevTools command-line API, which is
   why this has to run here rather than in a unit test. */
const DEAD_CONTROLS = `
(() => {
  const dead = [];
  const describe = (el, why) => {
    const label = (el.textContent || '').trim().slice(0, 40)
      || el.getAttribute('aria-label') || el.id || el.className;
    return why + ' → <' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '> "' + label + '"';
  };
  for (const el of document.querySelectorAll('button, a, [role="button"], [role="tab"]')) {
    if (el.offsetParent === null) continue;              // not visible
    if (el.disabled) continue;
    if (el.closest('[inert]')) continue;                 // deliberately not interactive
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (!href || href === '#') dead.push(describe(el, 'link with no href'));
      continue;
    }
    if (el.type === 'submit') {
      if (!el.form) dead.push(describe(el, 'submit button belongs to no form'));
      continue;
    }
    if ((getEventListeners(el).click || []).length) continue;
    let node = el.parentElement, delegated = false;
    while (node && !delegated) {
      if ((getEventListeners(node).click || []).length) delegated = true;
      node = node.parentElement;
    }
    if (!delegated) dead.push(describe(el, 'no click handler anywhere up the tree'));
  }
  return dead;
})()
`;

const A11Y = `
(() => {
  const problems = [];
  const seen = new Map();
  for (const el of document.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) || 0) + 1);
  for (const [dup, n] of seen) if (n > 1) problems.push('duplicate id #' + dup + ' (' + n + ' elements)');

  for (const input of document.querySelectorAll('input:not([type=hidden])')) {
    const named = input.labels?.length || input.getAttribute('aria-label') || input.getAttribute('aria-labelledby');
    if (!named) problems.push('input with no label: ' + (input.name || input.id || input.className));
  }
  for (const btn of document.querySelectorAll('button')) {
    if (btn.offsetParent === null) continue;
    const name = (btn.textContent || '').trim() || btn.getAttribute('aria-label') || btn.getAttribute('title');
    if (!name) problems.push('button with no accessible name: ' + (btn.id || btn.className));
  }
  for (const el of document.querySelectorAll('[aria-describedby], [aria-labelledby], [aria-controls]')) {
    for (const attr of ['aria-describedby', 'aria-labelledby', 'aria-controls']) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      for (const ref of v.split(/\\s+/)) {
        if (ref && !document.getElementById(ref)) {
          problems.push(attr + ' points at missing #' + ref + ' from ' + (el.id || el.tagName.toLowerCase()));
        }
      }
    }
  }
  for (const img of document.querySelectorAll('img')) {
    if (!img.hasAttribute('alt')) problems.push('img with no alt: ' + img.src);
  }
  return problems;
})()
`;

/* --------------------------------- routes --------------------------------- */

const findings = [];
async function audit(label, url, prepare) {
  consoleLog = [];
  await send('Page.navigate', { url });
  await send('Page.reload');
  await sleep(500);
  if (prepare) {
    const opened = await evaluate(prepare);
    if (!opened) findings.push(label + ': PREPARATION — requested control was absent');
    await sleep(150);
  }

  const dead = (await evaluate(DEAD_CONTROLS, true)) || [];
  const a11y = (await evaluate(A11Y, true)) || [];
  const errs = consoleLog.filter(e => !(staticOnly && e.includes('404') && e.includes(BASE + '/api/auth/me')));
  for (const d of dead) findings.push(`${label}: DEAD CONTROL — ${d}`);
  for (const a of a11y) findings.push(`${label}: A11Y — ${a}`);
  for (const e of errs) findings.push(`${label}: CONSOLE — ${e}`);
  console.log(`  ${label.padEnd(28)} ${dead.length} dead, ${a11y.length} a11y, ${errs.length} console`);
}

const click = (selector) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return !!el; })()`;

console.log(`sweeping ${BASE}`);
if (!process.argv.includes('--flows-only')) {
await audit('landing', `${BASE}/index.html`);
if (!staticOnly) {
await audit('landing + sign-in dialog', `${BASE}/index.html`, click('#landing-account button'));
}
await audit('app: reading lesson', `${BASE}/app.html#/lesson/m1l1`);
await audit('app: guided exercise', `${BASE}/app.html#/lesson/m1l3`);
await audit('app: challenge', `${BASE}/app.html#/lesson/m1l4`);
await audit('app: playground', `${BASE}/app.html#/playground`);
await audit('app: state reference', `${BASE}/app.html#/states`);
if (!staticOnly) {
await audit('app: sign-in dialog', `${BASE}/app.html#/lesson/m1l1`, click('#account button'));
await audit('app: sign-up dialog', `${BASE}/app.html#/lesson/m1l1`,
  `(() => { const b = document.querySelector('#account button'); if (b) b.click();
            const s = document.querySelector('.auth-swap'); if (s) s.click(); return !!s; })()`);
}
await audit('app: success dialog', `${BASE}/app.html#/lesson/m1l3`,
  `(async () => {
    const course = await (await fetch('./content/course.json')).json();
    const lesson = course.modules[0].lessons.find(l => l.id === 'm1l3');
    for (const step of lesson.exercise.steps) for (const command of step.cmd.split('\\n')) {
      const input = document.querySelector('.term-input');
      input.value = command;
      input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}));
    }
    return !!document.querySelector('#success-banner');
  })()`);
await audit('app: files overlay', `${BASE}/app.html#/lesson/m1l3`, click('#files-btn'));
await audit('app: focus mode', `${BASE}/app.html#/lesson/m1l3`,
  click('#layout-tabs button[data-layout=focus]'));
await audit('admin', `${BASE}/admin.html`);
const course = await (await fetch(BASE + '/content/course.json')).json();
for (const module of course.modules) {
  for (const lesson of module.lessons) await audit('lesson ' + lesson.id, BASE + '/app.html#/lesson/' + lesson.id);
  await audit('recap ' + module.id, BASE + '/app.html#/lesson/' + module.id + '-recap');
}
if (staticOnly) {
  const saved = await evaluate("(async () => { const p = await import('./ui/progress.js'); return (await new p.LocalStorageProgressStore().load()).completedLessons.includes('m1l3'); })()");
  if (!saved) findings.push('STATIC — completed exercise did not persist across route reloads');
  if (await evaluate("!document.querySelector('#account').hidden")) findings.push('STATIC — account control should be hidden');
  console.log('  static exercise completion persisted: ' + saved);
}
}
if (accounts) {
  try {
    consoleLog = [];
    await sweepFlows({ base: BASE, send, evaluate, outbox, store: fixture.store,
    async inspect(label) {
      for (const issue of [...await evaluate(DEAD_CONTROLS,true), ...await evaluate(A11Y,true)]) findings.push(label + ': ' + issue);
    }, check(label, ok) {
      console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + label);
      if (!ok) findings.push('BEHAVIOR — ' + label);
    } });
    for (const e of consoleLog.filter(e => e.startsWith('[exception]'))) findings.push('BEHAVIOR — ' + e);
  } catch (err) {
    findings.push('BEHAVIOR — ' + err.message);
    console.log(await evaluate("({url:location.href,dialog:document.querySelector('.auth-card')?.innerText,body:document.body.innerText.slice(-700)})"));
    console.log(consoleLog);
  }
}

console.log('');
if (findings.length) {
  console.log(`${findings.length} finding(s):`);
  for (const f of findings) console.log('  • ' + f);
} else {
  console.log('no findings');
}
ws.close();
stop();
process.exit(findings.length ? 1 : 0);
