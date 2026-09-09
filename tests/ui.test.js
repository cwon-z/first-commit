/* Static contract between the UI modules, the HTML shells and the repo wiring.
 *
 * There is no DOM in Node and no test framework here, so this checks the
 * things that silently break at runtime: a `$('#id')` whose element nobody
 * ever added, a script tag that stopped being loaded, and the accessibility
 * guarantees (focus ring, reduced motion, live region) quietly disappearing.
 *
 * Run:  node tests/ui.test.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) passed++;
  else { failed++; failures.push(name); }
}

const appHtml = read('app.html');
const indexHtml = read('index.html');
const adminHtml = read('admin.html');
const appCss = read('css', 'app.css');
const landingCss = read('css', 'landing.css');
const adminCss = read('css', 'admin.css');

/* Elements app.js builds itself — they are never in the HTML shell. */
const RUNTIME_IDS = new Set([
  'step-list',                             // renderGuidedPanel
  'check-list',                            // renderChallengePanel
  'challenge-hints',                       // refreshHintButtons
  'success-banner', 'sb-next',             // showSuccessBanner
  'toast',                                 // toast
  'mail-banner', 'mb-primary', 'mb-dismiss', // showMailBanner
]);

function idsIn(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

function idsUsedBy(source) {
  const used = new Set();
  const patterns = [
    /\$\('#([\w-]+)'\)/g,
    /querySelector(?:All)?\('#([\w-]+)'\)/g,
    /getElementById\('([\w-]+)'\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) used.add(m[1]);
  }
  return used;
}

/* --------- a submit button outside its form must be associated ----------- */
{
  const authJs = read('ui', 'auth.js');
  const declaresSubmit = /\.type = 'submit'/.test(authJs);
  const associates = /setAttribute\('form',/.test(authJs);
  const appendedToForm = /form\.append(Child)?\([^)]*submit/.test(authJs);
  // A type="submit" button that is neither inside its form nor associated with
  // it by id submits nothing when clicked — silently, with no error anywhere.
  ok(!declaresSubmit || associates || appendedToForm,
    'auth dialog: submit button is owned by a form');
}

/* ------------------- every referenced element exists --------------------- */
{
  const staticIds = idsIn(appHtml);
  const uiFiles = ['app.js', 'terminal.js', 'graph.js', 'filetree.js', 'lesson.js',
    'progress.js', 'states.js', 'icons.js', 'auth.js'];
  for (const file of uiFiles) {
    for (const id of idsUsedBy(read('ui', file))) {
      ok(staticIds.has(id) || RUNTIME_IDS.has(id),
        `ui/${file} references #${id}, which app.html defines or app.js creates`);
    }
  }

  const landingIds = idsIn(indexHtml);
  for (const id of idsUsedBy(read('ui', 'landing.js'))) {
    ok(landingIds.has(id), `ui/landing.js references #${id}, which index.html defines`);
  }

  const adminIds = idsIn(adminHtml);
  for (const id of idsUsedBy(read('ui', 'admin.js'))) {
    ok(adminIds.has(id), `ui/admin.js references #${id}, which admin.html defines`);
  }
}

/* ---------------------- the shells load their modules -------------------- */
{
  ok(/<script type="module" src="\.\/ui\/app\.js">/.test(appHtml), 'app.html loads ui/app.js as a module');
  ok(/<script type="module" src="\.\/ui\/landing\.js">/.test(indexHtml), 'index.html loads ui/landing.js as a module');
  ok(/<script type="module" src="\.\/ui\/admin\.js">/.test(adminHtml), 'admin.html loads ui/admin.js as a module');
  ok(appHtml.includes('./css/app.css'), 'app.html loads css/app.css');
  ok(indexHtml.includes('./css/landing.css'), 'index.html loads css/landing.css');
  ok(adminHtml.includes('./css/admin.css'), 'admin.html loads css/admin.css');
  for (const [name, html] of [['app.html', appHtml], ['index.html', indexHtml], ['admin.html', adminHtml]]) {
    ok(html.includes('./css/tokens.css'), `${name} loads the shared token layer`);
  }
  // The statistics page reads every learner's progress; it must never be indexed.
  ok(/<meta name="robots" content="noindex/.test(adminHtml), 'admin.html asks not to be indexed');
  // Relative paths only — the app has to survive being served from a subpath.
  ok(!/(?:src|href)="\/[^/]/.test(appHtml), 'app.html uses no absolute paths');
  ok(!/(?:src|href)="\/[^/]/.test(indexHtml), 'index.html uses no absolute paths');
  ok(!/(?:src|href)="\/[^/]/.test(adminHtml), 'admin.html uses no absolute paths');
}

/* ------------- every local asset a shell references really exists --------- */
{
  for (const [name, html] of [['app.html', appHtml], ['index.html', indexHtml], ['admin.html', adminHtml]]) {
    const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1]);
    ok(refs.length > 0, `${name} references local assets`);
    for (const ref of refs) {
      const target = ref.replace(/^\.\//, '').split(/[?#]/)[0];
      ok(fs.existsSync(path.join(ROOT, target)), `${name} → ${ref} exists on disk`);
    }
  }
  // app.js fetches this at boot; landing.js degrades without it but shouldn't have to.
  ok(fs.existsSync(path.join(ROOT, 'content', 'course.json')), 'content/course.json exists');
}

/* --------------------------- accessibility ------------------------------- */
{
  ok(appHtml.includes('aria-expanded'), 'the menu button reports its expanded state');
  ok(/id="graph-a11y"[^>]*aria-live="polite"/.test(appHtml), 'the graph has a polite live region');
  ok(/id="graph-a11y"[^>]*class="sr-only"/.test(appHtml), 'the graph live region is visually hidden');
  ok(read('ui', 'app.js').includes('aria-current'), 'the active lesson link is marked aria-current');

  for (const [name, css] of [['app.css', appCss], ['landing.css', landingCss], ['admin.css', adminCss]]) {
    ok(css.includes(':focus-visible'), `${name} defines a visible keyboard focus style`);
    ok(css.includes('.sr-only'), `${name} defines the screen-reader-only utility`);
    ok(css.includes('@media (prefers-reduced-motion: reduce)'), `${name} honours reduced motion`);
  }
  ok(read('ui', 'app.js').includes('prefers-reduced-motion'),
    'app.js honours reduced motion for programmatic scrolling');
}

/* ------------------------ no duplicated machinery ------------------------ */
{
  const app = read('ui', 'app.js');
  ok(!app.includes('function mdLite'), 'app.js has no second inline-markdown renderer');
  ok(app.includes("from './lesson.js'") && app.includes('inlineMd'), 'app.js reuses inlineMd from lesson.js');
  ok(read('ui', 'terminal.js').includes('destroy()'), 'Terminal can unbind its root listener');
  ok(app.includes('S.terminal.destroy()'), 'app.js tears the terminal down before rebuilding it');
  ok(app.includes('advanceSteps'), 'app.js uses the shared guided-step cascade');
  ok(app.includes('scrollGraphToHead'), 'app.js keeps HEAD in view in both axes of the graph');

  // R2: ui/progress.js is the only module allowed to touch storage or the API.
  for (const file of ['app.js', 'terminal.js', 'graph.js', 'filetree.js', 'lesson.js',
    'landing.js', 'states.js', 'icons.js', 'admin.js']) {
    ok(!read('ui', file).includes('localStorage'),
      `ui/${file} goes through the progress seam rather than localStorage`);
  }
  ok(read('ui', 'auth.js').includes("from './progress.js'"),
    'ui/auth.js calls the API through the seam, not with its own fetch');
  ok(!read('ui', 'auth.js').includes('fetch('),
    'ui/auth.js has no fetch of its own');
}

/* ------------------- the suite actually runs everything ------------------ */
/* CI once listed the test files by hand and quietly stopped covering a whole
 * suite when a new one was added. Now CI runs `npm test`, and this checks that
 * `npm test` in turn names every test file that exists. */
{
  const pkg = JSON.parse(read('package.json'));
  const script = pkg.scripts.test;
  const files = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.test.js'));
  ok(files.length > 0, 'there are test files to run');
  for (const file of files) {
    ok(script.includes(`tests/${file}`), `npm test runs tests/${file}`);
  }

  const workflow = read('.github', 'workflows', 'test.yml');
  ok(/run:\s*npm test/.test(workflow),
    'CI runs the whole suite via npm test, so it cannot fall behind again');
  ok(new RegExp(`node-version:.*matrix\\.node`).test(workflow) && /'18'/.test(workflow),
    "CI still tests the Node floor declared in package.json engines");
  ok(pkg.engines.node === '>=18', 'the declared Node floor still matches the CI matrix');
}

/* ------------------------------- report ---------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
