/* ============================================================================
 * first-commit — application controller
 * ----------------------------------------------------------------------------
 * Wires content (course.json) + engine (GitEngine) + UI components together.
 * Routing is hash-based (#/lesson/<id>, #/playground) so the app deploys as
 * plain static files behind any server (Caddy, nginx, python -m http.server).
 *
 * The shell has two shapes, chosen by `data-mode` on <body>:
 *
 *   read      one centred reading column; the workspace is not in play
 *   exercise  instructions rail + graph + terminal + file state
 *
 * and the exercise shape has two layouts, `split` and `focus`. `focus` shows
 * one panel at a time above a pinned terminal and is forced below 1000px —
 * that is how four regions fit on a 360px screen without any of them shrinking
 * to uselessness.
 * ========================================================================== */

import { GitEngine } from '../engine/git-engine.js';
import { runChecks, allPassed, advanceSteps } from '../engine/validators.js';
import { Terminal } from './terminal.js';
import { renderGraph } from './graph.js';
import { renderFiles } from './filetree.js';
import { renderBlocks, inlineMd } from './lesson.js';
import {
  LocalStorageProgressStore, LocalStoragePrefsStore, RestProgressStore,
  probeSession, chooseStore, mergeProgress,
} from './progress.js';
import { mountAccountControl } from './auth.js';
import { renderStates } from './states.js';
import { icon } from './icons.js';

/* ★ BACKEND SEAM. Which store this is depends on whether the optional server is
 *   there and whether anyone is signed in — decided once in boot(), swapped on
 *   sign-in and sign-out, and never asked about again. See ui/progress.js.   */
let store = new LocalStorageProgressStore();

/* View preferences share that seam so nothing else touches storage. */
const prefs = new LocalStoragePrefsStore();

const S = {
  course: null,
  progress: null,
  entries: [],       // flattened [{module, lesson}]
  current: null,     // current entry
  exMode: null,      // 'guided' | 'challenge' | 'playground' | null
  engine: null,
  terminal: null,
  stepIdx: 0,
  revealedHints: 0,
  completedThisView: false,
  session: null,     // null when the app is served statically, with no API
  mode: 'read',      // 'read' | 'exercise'
  layout: prefs.load().layout, // the learner's preference; narrow screens override it
  tab: 'steps',      // focus-mode panel: 'steps' | 'graph' | 'files'
  filesOpen: false,
  confirmReset: false,
  resetTimer: null,
};

const $ = (sel) => document.querySelector(sel);

/* Programmatic scrolling honours the OS "reduce motion" setting. */
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const scrollBehavior = () => (reducedMotion.matches ? 'auto' : 'smooth');

/* Below this width a 384px instructions rail leaves nothing for the graph. */
const wideEnough = window.matchMedia('(min-width: 1000px)');
const effectiveLayout = () => (wideEnough.matches ? S.layout : 'focus');

/* ------------------------------ shell chrome ------------------------------ */

/** Push the whole of `S`'s presentation state onto <body> in one place. */
function applyChrome() {
  const layout = effectiveLayout();
  document.body.dataset.mode = S.mode;
  document.body.dataset.layout = layout;
  document.body.dataset.tab = S.tab;
  document.body.classList.toggle('files-open', S.filesOpen);
  $('#files-btn').setAttribute('aria-pressed', String(S.filesOpen));
  for (const b of document.querySelectorAll('#layout-tabs button')) {
    b.setAttribute('aria-pressed', String(b.dataset.layout === S.layout));
  }
  for (const b of document.querySelectorAll('#work-tabs button')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
  }
}

/**
 * Persist, and surface a failure. The local store effectively cannot fail, but
 * the REST one can — and progress that quietly stopped saving is the worst
 * possible bug in a course somebody is spending hours on.
 */
function saveProgress() {
  return Promise.resolve(store.save(S.progress))
    .then(() => { $('#save-note').hidden = true; })
    .catch((err) => {
      console.warn('progress save failed:', err);
      const note = $('#save-note');
      note.textContent = err && err.status === 401
        ? 'Signed out — progress not saved'
        : 'Offline — progress not saved';
      note.hidden = false;
    });
}

function setSidebar(open) {
  $('#sidebar').classList.toggle('open', open);
  document.body.classList.toggle('nav-open', open);
  $('#menu-btn').setAttribute('aria-expanded', String(open));
}
const closeSidebar = () => setSidebar(false);

/* ------------------------------- bootstrap ------------------------------- */

async function boot() {
  const res = await fetch('./content/course.json');
  if (!res.ok) {
    throw new Error(`GET content/course.json → HTTP ${res.status} ${res.statusText}`);
  }
  S.course = await res.json();

  // No server → probeSession resolves null and everything below is unchanged;
  // this is what keeps the static deployment working exactly as it did.
  S.session = await probeSession();
  store = chooseStore(S.session);
  S.progress = await store.load();
  document.title = `${S.course.meta.brand} — interactive Git course`;
  $('#brand-name').textContent = S.course.meta.brand;
  buildSidebar();
  window.addEventListener('hashchange', route);

  const menuBtn = $('#menu-btn');
  menuBtn.addEventListener('click', () => setSidebar(!$('#sidebar').classList.contains('open')));
  $('#sidebar-scrim').addEventListener('click', closeSidebar);
  $('#playground-link').addEventListener('click', closeSidebar);
  $('#states-link').addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if ($('#sidebar').classList.contains('open')) {
      closeSidebar();
      menuBtn.focus();
    } else if ($('#success-banner')) {
      dismissSuccess();
    }
  });
  $('#reset-progress').addEventListener('click', resetProgress);

  for (const b of document.querySelectorAll('#layout-tabs button')) {
    b.addEventListener('click', () => {
      S.layout = b.dataset.layout;
      prefs.save({ ...prefs.load(), layout: S.layout });
      applyChrome();
    });
  }
  for (const b of document.querySelectorAll('#work-tabs button')) {
    b.addEventListener('click', () => { S.tab = b.dataset.tab; applyChrome(); });
  }
  $('#files-btn').addEventListener('click', () => { S.filesOpen = !S.filesOpen; applyChrome(); });
  $('#files-close').addEventListener('click', () => { S.filesOpen = false; applyChrome(); });
  $('#now-bar').addEventListener('click', () => { S.tab = 'steps'; applyChrome(); });
  wideEnough.addEventListener('change', applyChrome);
  $('#lesson-pane').addEventListener('scroll', updateReadProgress, { passive: true });

  if (S.session) {
    mountAccountControl($('#account'), { session: S.session, onChange: onAccountChange });
  }

  applyChrome();
  route();
}

/**
 * Sign-in and sign-out swap the store underneath the app.
 *
 * On sign-in the guest's local progress is merged up rather than discarded —
 * somebody who worked through three modules before making an account would
 * quite reasonably never come back if that work vanished the moment they
 * signed up.
 */
async function onAccountChange(user) {
  if (user) {
    const local = await new LocalStorageProgressStore().load();
    store = new RestProgressStore();
    const remote = await store.load();
    const merged = mergeProgress(local, remote);
    S.progress = merged;
    if (merged.completedLessons.length > remote.completedLessons.length) await saveProgress();
  } else {
    store = new LocalStorageProgressStore();
    S.progress = await store.load();
  }
  $('#save-note').hidden = true;
  buildSidebar();
  if (S.current) show(S.current); else route();
}

/* ------------------------------ lesson index ----------------------------- */

function flatten() {
  const entries = [];
  for (const mod of S.course.modules) {
    for (const lesson of mod.lessons) entries.push({ module: mod, lesson });
    if (mod.recap && mod.status === 'ready') {
      entries.push({
        module: mod,
        lesson: { id: `${mod.id}-recap`, title: 'Module recap', type: 'recap', body: mod.recap.body },
      });
    }
  }
  return entries;
}

function isDone(lessonId) {
  return S.progress.completedLessons.includes(lessonId);
}

function playableEntries() {
  return S.entries.filter((e) => !e.lesson.comingSoon);
}

/* -------------------------------- sidebar -------------------------------- */

/** Concept · guided · challenge · recap each get their own mark, so the shape
 *  of a module is readable before any of it is opened. */
function lessonMark(entry) {
  if (entry.lesson.comingSoon) return '◌';
  if (isDone(entry.lesson.id)) return '✓';
  return { guided: '›', challenge: '◇', recap: '≡' }[entry.lesson.type] || '·';
}

function buildSidebar() {
  S.entries = flatten();
  const nav = $('#module-nav');
  // This runs again on every lesson completion; without remembering the
  // <details> state it would re-expand every module the learner had collapsed.
  const wasOpen = new Map();
  nav.querySelectorAll('.nav-module').forEach((d) => wasOpen.set(d.dataset.mod, d.open));
  nav.innerHTML = '';

  for (const mod of S.course.modules) {
    const modEntries = S.entries.filter((e) => e.module.id === mod.id);
    const modDone = modEntries
      .filter((e) => !e.lesson.comingSoon)
      .every((e) => isDone(e.lesson.id));

    const details = document.createElement('details');
    details.className = 'nav-module' + (modDone ? ' mod-done' : '');
    details.dataset.mod = mod.id;
    details.open = wasOpen.has(mod.id) ? wasOpen.get(mod.id) : mod.status === 'ready';

    const summary = document.createElement('summary');
    summary.innerHTML = '<span class="nav-mod-num"></span><span class="nav-mod-title"></span>' +
      '<span class="nav-mod-badge"></span><span class="nav-caret" aria-hidden="true">▸</span>';
    summary.querySelector('.nav-mod-num').textContent = String(mod.number).padStart(2, '0');
    summary.querySelector('.nav-mod-title').textContent = mod.title;
    const badge = summary.querySelector('.nav-mod-badge');
    if (mod.status !== 'ready') { badge.textContent = 'soon'; badge.classList.add('badge-soon'); }
    else if (modDone) { badge.textContent = '✓'; badge.title = 'Module complete'; }
    details.appendChild(summary);

    const ul = document.createElement('ul');
    ul.className = 'nav-lessons';
    for (const entry of modEntries) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#/lesson/${entry.lesson.id}`;
      a.dataset.lesson = entry.lesson.id;
      a.className = 'nav-lesson';
      if (entry.lesson.comingSoon) a.classList.add('nav-soon');
      if (isDone(entry.lesson.id)) a.classList.add('done');
      a.innerHTML = '<span class="nav-icon" aria-hidden="true"></span><span class="nav-title"></span>';
      a.querySelector('.nav-icon').textContent = lessonMark(entry);
      a.querySelector('.nav-title').textContent = entry.lesson.title;
      a.addEventListener('click', closeSidebar);
      li.appendChild(a);
      ul.appendChild(li);
    }
    details.appendChild(ul);
    nav.appendChild(details);
  }

  updateProgressPill();
}

function updateProgressPill() {
  const playable = playableEntries();
  const done = playable.filter((e) => isDone(e.lesson.id)).length;
  const pct = playable.length ? Math.round((done / playable.length) * 100) : 0;
  $('#progress-pill').textContent = `${done}/${playable.length} · ${pct}%`;
  $('#progress-bar-fill').style.width = pct + '%';
  $('#progress-metric').textContent = String(pct);
  $('#progress-units').textContent = `${done}/${playable.length} units`;
}

function markActive(lessonId) {
  document.querySelectorAll('.nav-lesson').forEach((a) => {
    const on = a.dataset.lesson === lessonId;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/** Destructive, so it asks twice — the second tap inside four seconds fires. */
async function resetProgress() {
  const btn = $('#reset-progress');
  const done = S.progress.completedLessons.length;
  if (!done) {
    btn.textContent = 'Nothing saved yet';
    window.clearTimeout(S.resetTimer);
    S.resetTimer = window.setTimeout(() => { btn.textContent = 'Reset progress'; }, 2400);
    return;
  }
  if (!S.confirmReset) {
    S.confirmReset = true;
    btn.textContent = `Tap again to erase ${done} completed`;
    btn.classList.add('btn-danger');
    btn.classList.remove('btn-ghost');
    window.clearTimeout(S.resetTimer);
    S.resetTimer = window.setTimeout(cancelResetConfirm, 4000);
    return;
  }
  cancelResetConfirm();
  await store.clear();
  S.progress = await store.load();
  buildSidebar();
  if (S.current) show(S.current); else route();
}

function cancelResetConfirm() {
  const btn = $('#reset-progress');
  window.clearTimeout(S.resetTimer);
  S.confirmReset = false;
  btn.textContent = 'Reset progress';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-ghost');
}

/* -------------------------------- routing -------------------------------- */

function route() {
  dismissSuccess();
  const hash = location.hash || '';
  const m = hash.match(/^#\/lesson\/([\w-]+)/);
  if (m) {
    const entry = S.entries.find((e) => e.lesson.id === m[1]);
    if (entry) { show(entry); return; }
  }
  if (hash.startsWith('#/playground')) { showPlayground(); return; }
  if (hash.startsWith('#/states')) { showStates(); return; }
  // default: resume where the learner left off, else first incomplete lesson
  const resume = S.progress.lastLessonId && S.entries.find((e) => e.lesson.id === S.progress.lastLessonId);
  const firstIncomplete = playableEntries().find((e) => !isDone(e.lesson.id));
  const target = resume || firstIncomplete || S.entries[0];
  location.hash = `#/lesson/${target.lesson.id}`;
}

/* ------------------------------ lesson views ------------------------------ */

function graphFromOps(ops) {
  const wrap = document.createElement('div');
  wrap.className = 'figure-graph-scroll';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const e = new GitEngine();
  e.applySetup(ops);
  renderGraph(svg, e.getGraph());
  wrap.appendChild(svg);
  return wrap;
}

const KICKERS = {
  concept: 'Concept',
  guided: 'Guided exercise',
  challenge: 'Challenge',
  recap: 'Recap',
};

/** Rough reading length, so a learner can tell a 3-minute page from a 10. */
function wordCount(blocks = []) {
  let n = 0;
  for (const b of blocks) {
    const text = b.p ?? b.h ?? b.analogy ?? b.tip ?? b.warn ?? b.code ??
      (Array.isArray(b.list) ? b.list.join(' ') : null) ??
      (b.graph && b.graph.caption) ?? '';
    if (text) n += String(text).trim().split(/\s+/).length;
  }
  return n;
}

function lessonHead(entry) {
  const { module: mod, lesson } = entry;
  const head = document.createElement('div');
  head.className = 'lesson-head';

  const kicker = document.createElement('p');
  kicker.className = 'lesson-kicker';
  kicker.textContent = `Module ${String(mod.number).padStart(2, '0')} · ` +
    (KICKERS[lesson.type] || 'Lesson');

  const h1 = document.createElement('h1');
  h1.className = 'lesson-title';
  h1.textContent = lesson.title;

  head.append(kicker, h1);

  // A lesson that isn't written yet has a body, but nobody is going to read it
  // here — quoting a word count for a page that shows a placeholder is a lie.
  const words = lesson.comingSoon ? 0 : wordCount(lesson.body);
  if (words) {
    const meta = document.createElement('p');
    meta.className = 'lesson-meta';
    meta.innerHTML = '<span></span><span aria-hidden="true">·</span><span></span>';
    const [w, , m] = meta.querySelectorAll('span');
    w.textContent = `${words} words`;
    m.textContent = `${Math.max(1, Math.round(words / 200))} min read`;
    head.appendChild(meta);
  }
  return head;
}

function show(entry) {
  S.current = entry;
  S.completedThisView = false;
  dismissSuccess();
  // Never resume onto a lesson that isn't written yet — that's a dead end.
  if (!entry.lesson.comingSoon) {
    S.progress.lastLessonId = entry.lesson.id;
    saveProgress();
  }
  markActive(entry.lesson.id);

  const { module: mod, lesson } = entry;
  $('#crumb').textContent = `Module ${mod.number} · ${mod.title}`;
  const article = $('#lesson-article');
  article.classList.remove('states-page');
  article.innerHTML = '';
  article.appendChild(lessonHead(entry));

  if (lesson.comingSoon) {
    renderComingSoon(article, mod);
    hideWorkspace();
    return;
  }

  renderBlocks(article, lesson.body || [], { graphFromOps });

  if (lesson.type === 'guided' || lesson.type === 'challenge') {
    setupWorkspace(entry, lesson.type);
  } else {
    hideWorkspace();
    article.appendChild(continueControls(entry, lesson.type === 'recap' ? 'Finish module' : 'Got it — continue'));
  }

  $('#lesson-pane').scrollTop = 0;
  updateReadProgress();
}

function renderComingSoon(article, mod) {
  const d = document.createElement('div');
  d.className = 'coming-soon-card';
  d.innerHTML = `<p class="cs-emoji" aria-hidden="true">🚧</p>
    <p class="cs-text">This lesson is being written. The module will cover:</p>
    <p class="cs-summary"></p>
    <p class="cs-note">The sandbox already supports these commands — try them in the <a href="#/playground">Playground</a>.</p>`;
  d.querySelector('.cs-summary').textContent = mod.summary;
  article.appendChild(d);
}

function nextEntry(entry) {
  const playable = playableEntries();
  const idx = playable.findIndex((e) => e.lesson.id === entry.lesson.id);
  return playable[idx + 1] || null;
}

function continueControls(entry, label) {
  const wrap = document.createElement('div');
  wrap.className = 'lesson-actions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-solid btn-lg';
  btn.append(isDone(entry.lesson.id) ? 'Continue' : label, icon('arrow-right'));
  btn.addEventListener('click', () => {
    completeLesson(entry.lesson.id, false);
    gotoNext(entry);
  });
  wrap.appendChild(btn);

  const next = nextEntry(entry);
  const hint = document.createElement('span');
  hint.className = 'next-hint';
  hint.textContent = next ? `Next: ${next.lesson.title}` : 'That was the last unit — nice work.';
  wrap.appendChild(hint);
  return wrap;
}

function gotoNext(entry) {
  const next = nextEntry(entry);
  if (next) location.hash = `#/lesson/${next.lesson.id}`;
}

function completeLesson(lessonId, celebrate = true) {
  if (!isDone(lessonId)) {
    S.progress.completedLessons.push(lessonId);
    saveProgress();
    buildSidebar();
    markActive(lessonId);
  }
  if (celebrate && !S.completedThisView) {
    S.completedThisView = true;
    showSuccessBanner();
  }
}

/** The moment an exercise is solved — the emotional peak of a module, so it
 *  takes over the workspace rather than scrolling past in the rail. */
function showSuccessBanner() {
  dismissSuccess();
  const entry = S.current;
  const lesson = entry ? entry.lesson : null;
  const mod = entry ? entry.module : null;
  const next = entry ? nextEntry(entry) : null;

  const overlay = document.createElement('div');
  overlay.id = 'success-banner';
  overlay.innerHTML = `<div class="sb-inner" role="dialog" aria-modal="true" aria-labelledby="sb-title">
      <div class="sb-head">
        <span class="sb-check" aria-hidden="true">✓</span>
        <span class="sb-kicker"></span>
      </div>
      <h2 class="sb-title" id="sb-title"></h2>
      <p class="sb-sub"></p>
      <ul class="sb-list"></ul>
      <div class="sb-actions">
        <button class="btn btn-solid btn-lg" id="sb-next" type="button"></button>
        <button class="btn btn-ghost btn-lg sb-stay" type="button">Keep playing here</button>
      </div>
    </div>`;

  overlay.querySelector('.sb-kicker').textContent = mod
    ? `Module ${String(mod.number).padStart(2, '0')} · ${(KICKERS[lesson.type] || 'Exercise').toUpperCase()} COMPLETE`
    : 'EXERCISE COMPLETE';
  overlay.querySelector('.sb-title').textContent = lesson ? lesson.title : 'Exercise complete';
  overlay.querySelector('.sb-sub').textContent =
    'Your repository is in the state the exercise asked for — checked against the repo itself, not the commands you typed.';

  const list = overlay.querySelector('.sb-list');
  for (const label of achievements(entry)) {
    const li = document.createElement('li');
    li.textContent = label;
    list.appendChild(li);
  }

  const nextBtn = overlay.querySelector('#sb-next');
  nextBtn.append(next ? 'Continue' : 'Back to the course', icon('arrow-right'));
  nextBtn.addEventListener('click', () => { dismissSuccess(); gotoNext(S.current); });
  overlay.querySelector('.sb-stay').addEventListener('click', dismissSuccess);

  $('#main').appendChild(overlay);
  nextBtn.focus({ preventScroll: true });
}

/** What the learner actually did, pulled from the exercise definition. */
function achievements(entry) {
  const ex = entry && entry.lesson.exercise;
  if (!ex) return [];
  if (ex.expect) return ex.expect.map((c) => c.label || c.kind).slice(0, 6);
  if (ex.steps) return ex.steps.map((s) => stripMd(s.say)).slice(0, 6);
  return [];
}

/** Plain text from a `say` string — the success list is not a rich surface. */
function stripMd(s) {
  return String(s || '').replace(/[`*]/g, '');
}

function dismissSuccess() {
  const old = $('#success-banner');
  if (old) old.remove();
}

/* --------------------------- reading progress ----------------------------- */

function updateReadProgress() {
  const pane = $('#lesson-pane');
  const fill = $('#read-progress-fill');
  if (!pane || !fill) return;
  const span = pane.scrollHeight - pane.clientHeight;
  const pct = span > 8 ? Math.min(100, Math.round((pane.scrollTop / span) * 100)) : 0;
  fill.style.width = pct + '%';
}

/* ------------------------------- workspace ------------------------------- */

function hideWorkspace() {
  S.mode = 'read';
  S.exMode = null;
  S.filesOpen = false;
  $('#workspace').classList.add('hidden');
  $('#exercise-panel').innerHTML = '';
  if (S.terminal) { S.terminal.destroy(); S.terminal = null; }
  applyChrome();
}

function promptText() {
  if (!S.engine) return '~/project $';
  let ctx = '';
  if (S.engine.initialized) {
    if (S.engine.mergeState) ctx = ` (${S.engine.currentBranch() || 'HEAD'}|MERGING)`;
    else if (S.engine.HEAD.type === 'commit') ctx = ' (HEAD detached)';
    else ctx = ` (${S.engine.currentBranch()})`;
  }
  return `~/project${ctx} $`;
}

function setupWorkspace(entry, mode) {
  const ex = entry.lesson.exercise || { setup: [] };
  S.mode = 'exercise';
  S.exMode = mode;
  S.tab = 'steps';
  S.filesOpen = false;
  $('#workspace').classList.remove('hidden');
  S.engine = new GitEngine();
  S.engine.applySetup(ex.setup || []);
  for (const w of S.engine.setupWarnings) {
    console.warn(`${entry.lesson.id}: ${w}`);
  }
  S.stepIdx = 0;
  S.revealedHints = 0;

  $('#ex-title').textContent = entry.lesson.title;

  const panel = $('#exercise-panel');
  panel.innerHTML = '';
  if (mode === 'guided') renderGuidedPanel(panel, entry);
  else if (mode === 'challenge') renderChallengePanel(panel, entry);
  else renderPlaygroundPanel(panel);

  // terminal — tear the previous one down first, otherwise its listeners pile
  // up on the persistent #terminal element on every lesson change and reset.
  if (S.terminal) S.terminal.destroy();
  const termRoot = $('#terminal');
  S.terminal = new Terminal(termRoot, {
    promptText,
    completer: () => S.engine.completions(),
    onCommand: (line) => handleCommand(line, entry, mode),
  });
  S.terminal.print('Sandbox ready. This terminal simulates git — nothing here touches your computer.', 'dim');
  S.terminal.print("Type 'help' for available commands." + (mode !== 'playground' ? " Type 'hint' if you're stuck." : ''), 'dim');
  S.terminal.printBlank();

  $('#reset-btn').onclick = () => { setupWorkspace(entry, mode); };

  applyChrome();
  updateVisuals();
  if (window.matchMedia('(min-width: 900px)').matches) S.terminal.focus();
}

/** Run a command as though the learner had typed it (step "run it for me"). */
function runLine(line) {
  if (!S.terminal || !S.current) return;
  S.terminal.echo(line);
  S.terminal.history.push(line);
  handleCommand(line, S.current, S.exMode);
  S.terminal.refreshPrompt();
  S.terminal.scrollToEnd();
  S.terminal.focus();
}

function handleCommand(line, entry, mode) {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed === 'help') {
    S.terminal.print(S.engine.usage().replace('usage: git <command> [<args>]',
      'Shell commands:  ls · cat <f> · echo "text" > <f> · echo "text" >> <f> · touch · rm · pwd · clear\n\nusage: git <command> [<args>]'));
    return;
  }
  if (trimmed === 'hint') {
    revealHint(entry, mode);
    return;
  }
  const res = S.engine.run(trimmed);
  if (res.clear) S.terminal.clear();
  else if (res.output) S.terminal.print(res.output);
  updateVisuals();
  if (mode === 'guided') checkGuided(entry);
  else if (mode === 'challenge') checkChallenge(entry);
}

function updateVisuals() {
  const graph = S.engine.getGraph();
  const svg = $('#graph-svg');
  const drawn = renderGraph(svg, graph);
  const scroller = $('#graph-scroll');
  scroller.classList.toggle('is-empty', !!drawn.empty);
  scrollGraphToHead(scroller, svg);
  const files = S.engine.getFileState();
  renderFiles($('#files-panel'), files);
  const head = S.engine.headCommit();
  $('#graph-headline').textContent = head ? `HEAD: ${head.message}` : '';
  $('#graph-a11y').textContent = graphSummary(graph);
  updateFilesBadge(files);
  updateNowBar();
}

/** The Files control carries the number of files that are not clean, so the
 *  panel does not have to be open for a change to be noticed. */
function updateFilesBadge(files) {
  const busy = [...files.working, ...files.index]
    .filter((f) => f.state !== 'clean' && f.state !== 'ignored').length;
  $('#files-count').textContent = busy ? String(busy) : '';
}

/**
 * Keep the commit you just moved in view. Scrolling only to the right was
 * enough until branches arrived — now HEAD is often on a lower lane, and the
 * learner would see an unchanged picture after a command that did something.
 * The SVG's width/height attributes match its viewBox, so graph units are CSS
 * pixels and the node transform can be used directly.
 */
function scrollGraphToHead(scroller, svg) {
  const ring = svg.querySelector('.node-head-ring');
  const transform = ring && ring.parentNode.getAttribute('transform');
  const at = transform && /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(transform);
  if (!at) { scroller.scrollLeft = scroller.scrollWidth; return; }
  const x = parseFloat(at[1]);
  const y = parseFloat(at[2]);
  scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 2);
  scroller.scrollTop = Math.max(0, y - scroller.clientHeight / 2);
}

/** The commit graph is the core teaching visual; say out loud what it shows. */
function graphSummary(g) {
  if (!g.initialized) return 'No repository yet. Run git init to begin.';
  if (!g.commits.length) return 'Repository initialised. No commits yet.';
  const n = g.commits.length;
  const where = g.head.detached
    ? `HEAD is detached at commit ${g.commits.find((c) => c.id === g.head.id)?.short}`
    : `HEAD is on branch ${g.head.ref}`;
  const names = g.branches.map((b) => b.name);
  const branches = names.length
    ? `${names.length === 1 ? 'Branch' : 'Branches'}: ${names.join(', ')}.`
    : 'No branches yet.';
  const remotes = g.remoteBranches.length
    ? ` Remote refs: ${g.remoteBranches.map((r) => r.name).join(', ')}.`
    : '';
  return `${n} commit${n === 1 ? '' : 's'}. ${where}. ${branches}${remotes}` +
    (g.merging ? ' A merge is in progress.' : '');
}

/* ---------------------------- exercise progress --------------------------- */

/** The tick row in the exercise bar: one mark per step or per condition. */
function renderTicks(states) {
  const row = $('#ex-ticks');
  row.innerHTML = '';
  for (const state of states) {
    const t = document.createElement('span');
    t.className = 'tick' + (state ? ' tick-' + state : '');
    row.appendChild(t);
  }
}

/** The one-line "what am I meant to be doing" bar, used in focus mode where
 *  the instructions are behind a tab. */
function updateNowBar() {
  const text = $('#now-text');
  if (S.exMode === 'guided' && S.current) {
    const steps = S.current.lesson.exercise.steps;
    const step = steps[Math.min(S.stepIdx, steps.length - 1)];
    text.textContent = S.stepIdx >= steps.length
      ? 'All steps done.'
      : stripMd(step.say);
  } else if (S.exMode === 'challenge' && S.current) {
    text.textContent = $('#ex-progress').textContent || 'Work towards the goal.';
  } else {
    text.textContent = 'Free sandbox — nothing to solve.';
  }
}

/* ------------------------------ guided mode ------------------------------ */

function renderGuidedPanel(panel, entry) {
  const steps = entry.lesson.exercise.steps;
  const ol = document.createElement('ol');
  ol.className = 'step-list';
  ol.id = 'step-list';

  steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.className = 'step';
    li.dataset.idx = i;
    li.innerHTML = `
      <span class="step-marker" aria-hidden="true"></span>
      <div class="step-body">
        <div class="step-say"></div>
        ${step.cmd ? '<pre class="step-cmd"><code></code></pre>' : ''}
        <div class="step-tools"></div>
        <p class="step-hint" hidden></p>
      </div>`;
    li.querySelector('.step-say').innerHTML = inlineMd(step.say);

    const tools = li.querySelector('.step-tools');
    if (step.cmd) {
      li.querySelector('.step-cmd code').textContent = step.cmd;
      const run = document.createElement('button');
      run.type = 'button';
      run.className = 'btn btn-sm';
      run.append(icon('play'), 'Run it for me');
      run.addEventListener('click', () => runLine(String(step.cmd).split('\n')[0]));
      tools.appendChild(run);
    }
    if (step.hint) {
      const hintEl = li.querySelector('.step-hint');
      hintEl.textContent = step.hint;
      const hintBtn = document.createElement('button');
      hintBtn.type = 'button';
      hintBtn.className = 'btn btn-sm btn-ghost';
      hintBtn.textContent = 'Stuck?';
      hintBtn.setAttribute('aria-expanded', 'false');
      hintBtn.addEventListener('click', () => {
        hintEl.hidden = !hintEl.hidden;
        hintBtn.textContent = hintEl.hidden ? 'Stuck?' : 'Hide hint';
        hintBtn.setAttribute('aria-expanded', String(!hintEl.hidden));
      });
      tools.appendChild(hintBtn);
    }
    ol.appendChild(li);
  });

  panel.appendChild(ol);
  refreshGuidedUI(entry);
}

function refreshGuidedUI(entry) {
  const steps = entry.lesson.exercise.steps;
  document.querySelectorAll('#step-list .step').forEach((li) => {
    const i = Number(li.dataset.idx);
    li.classList.toggle('step-done', i < S.stepIdx);
    li.classList.toggle('step-current', i === S.stepIdx);
    li.classList.toggle('step-future', i > S.stepIdx);
    li.querySelector('.step-marker').textContent = i < S.stepIdx ? '✓' : String(i + 1);
  });
  renderTicks(steps.map((s, i) => (i < S.stepIdx ? 'done' : i === S.stepIdx ? 'now' : '')));
  $('#ex-progress').textContent = `Step ${Math.min(S.stepIdx + 1, steps.length)} of ${steps.length}`;
  const current = document.querySelector('#step-list .step-current');
  if (current) current.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
  updateNowBar();
}

function checkGuided(entry) {
  const steps = entry.lesson.exercise.steps;
  const next = advanceSteps(S.engine, steps, S.stepIdx);
  if (next === S.stepIdx) return;
  S.stepIdx = next;
  refreshGuidedUI(entry);
  if (S.stepIdx >= steps.length) completeLesson(entry.lesson.id);
}

function revealHint(entry, mode) {
  if (mode === 'guided') {
    const step = entry.lesson.exercise.steps[S.stepIdx];
    if (step && step.hint) S.terminal.print('hint: ' + step.hint, 'dim');
    else S.terminal.print('hint: follow the current step in the panel.', 'dim');
  } else if (mode === 'challenge') {
    const hints = entry.lesson.exercise.hints || [];
    if (S.revealedHints < hints.length) {
      S.revealedHints++;
      refreshHintButtons(entry);
    }
    const shown = hints.slice(0, Math.max(S.revealedHints, 1));
    S.terminal.print('hint: ' + shown[shown.length - 1], 'dim');
  } else {
    S.terminal.print('hint: this is a free sandbox — nothing to solve. Try `git init`!', 'dim');
  }
}

/* ----------------------------- challenge mode ----------------------------- */

function railSection(eyebrow) {
  const wrap = document.createElement('div');
  wrap.className = 'rail-section';
  const label = document.createElement('span');
  label.className = 'eyebrow';
  label.textContent = eyebrow;
  wrap.appendChild(label);
  return wrap;
}

function renderChallengePanel(panel, entry) {
  const ex = entry.lesson.exercise;

  const goalWrap = railSection('The goal');
  const goal = document.createElement('p');
  goal.className = 'rail-goal';
  goal.innerHTML = inlineMd(ex.goal);
  goalWrap.appendChild(goal);
  panel.appendChild(goalWrap);

  const checksWrap = railSection('Conditions');
  const list = document.createElement('ul');
  list.className = 'check-list';
  list.id = 'check-list';
  ex.expect.forEach((check, i) => {
    const li = document.createElement('li');
    li.className = 'check-item';
    li.dataset.idx = i;
    li.innerHTML = '<span class="check-box" aria-hidden="true"></span>' +
      '<span class="check-label"></span><span class="check-state"></span>';
    li.querySelector('.check-label').textContent = check.label || check.kind;
    list.appendChild(li);
  });
  checksWrap.appendChild(list);
  panel.appendChild(checksWrap);

  if (ex.hints && ex.hints.length) {
    const hintWrap = document.createElement('div');
    hintWrap.className = 'challenge-hints';
    hintWrap.id = 'challenge-hints';
    panel.appendChild(hintWrap);
  }

  refreshHintButtons(entry);
  refreshChecklist(entry);
}

function refreshHintButtons(entry) {
  const hints = entry.lesson.exercise.hints || [];
  const hintWrap = $('#challenge-hints');
  if (!hintWrap) return;
  hintWrap.innerHTML = '';
  hints.slice(0, S.revealedHints).forEach((h, i) => {
    const d = document.createElement('div');
    d.className = 'hint-revealed';
    d.innerHTML = '<span class="hint-num"></span><span class="hint-text"></span>';
    d.querySelector('.hint-num').textContent = `Hint ${i + 1}`;
    d.querySelector('.hint-text').textContent = h;
    hintWrap.appendChild(d);
  });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-sm btn-quiet';
  btn.appendChild(icon('lightbulb'));
  if (S.revealedHints >= hints.length) {
    btn.append('No hints left');
    btn.disabled = true;
  } else {
    btn.append(S.revealedHints === 0
      ? `Reveal a hint (${hints.length} available)`
      : `Reveal another (${hints.length - S.revealedHints} left)`);
    btn.addEventListener('click', () => { S.revealedHints++; refreshHintButtons(entry); });
  }
  hintWrap.appendChild(btn);
}

function refreshChecklist(entry) {
  const res = runChecks(S.engine, entry.lesson.exercise.expect);
  document.querySelectorAll('#check-list .check-item').forEach((li) => {
    const i = Number(li.dataset.idx);
    const passed = res[i].passed;
    li.classList.toggle('check-pass', passed);
    li.querySelector('.check-box').textContent = passed ? '✓' : '';
    li.querySelector('.check-state').textContent = passed ? 'met' : 'waiting';
  });
  const passedCount = res.filter((r) => r.passed).length;
  renderTicks(res.map((r) => (r.passed ? 'done' : '')));
  $('#ex-progress').textContent = `${passedCount} of ${res.length} conditions met`;
  updateNowBar();
  return res;
}

function checkChallenge(entry) {
  const res = refreshChecklist(entry);
  if (allPassed(res)) completeLesson(entry.lesson.id);
}

/* ------------------------------- playground ------------------------------- */

const EXPERIMENTS = [
  ['Put the folder under Git and take a first snapshot', 'git init'],
  ['See what Git currently thinks about your files', 'git status'],
  ['Stage everything in the folder', 'git add .'],
  ['Record a snapshot with a message', 'git commit -m "first"'],
  ['Read the history one line per commit', 'git log --oneline'],
  ['Branch off and keep working somewhere else', 'git switch -c experiment'],
  ['Bring a branch back into main', 'git merge experiment'],
  ['Find out where HEAD has been', 'git reflog'],
];

function showPlayground() {
  S.current = null;
  markActive('');
  $('#crumb').textContent = 'Playground';
  const article = $('#lesson-article');
  article.classList.remove('states-page');
  article.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'lesson-head';
  head.innerHTML = '<p class="lesson-kicker">Sandbox</p><h1 class="lesson-title">Playground</h1>';
  article.appendChild(head);

  const entry = {
    module: { number: '∞', title: 'Playground' },
    lesson: {
      id: 'playground',
      title: 'Playground',
      type: 'playground',
      exercise: {
        setup: [{ op: 'write', path: 'readme.md', content: '# playground\nAnything goes here.' }],
      },
    },
  };
  S.current = entry;
  setupWorkspace(entry, 'playground');
  $('#ex-title').textContent = 'Playground — free sandbox';
}

/* ------------------------------ state reference --------------------------- */

/** Not a lesson: the §5 review checklist, rendered from live components. */
function showStates() {
  S.current = null;
  markActive('');
  hideWorkspace();
  $('#crumb').textContent = 'State reference';
  const article = $('#lesson-article');
  article.classList.add('states-page');
  article.innerHTML = '';
  renderStates(article);
  $('#lesson-pane').scrollTop = 0;
  updateReadProgress();
}

function renderPlaygroundPanel(panel) {
  const intro = railSection('How this works');
  const p = document.createElement('p');
  p.className = 'rail-p';
  p.textContent = 'No goals and no checklist. Nothing here is graded, and reset puts the ' +
    'folder back to one file. A simulated remote is available too — add one with ' +
    'git remote add origin, then push.';
  intro.appendChild(p);
  panel.appendChild(intro);

  const ideas = railSection('Ideas to try');
  panel.appendChild(ideas);

  const wrap = document.createElement('div');
  wrap.className = 'experiments';
  for (const [title, cmd] of EXPERIMENTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'experiment';
    btn.innerHTML = '<span></span><code></code>';
    btn.querySelector('span').textContent = title;
    btn.querySelector('code').textContent = cmd;
    btn.addEventListener('click', () => runLine(cmd));
    wrap.appendChild(btn);
  }
  panel.appendChild(wrap);

  renderTicks([]);
  $('#ex-progress').textContent = '';
}

/* --------------------------------- start --------------------------------- */

if (typeof document !== 'undefined' && document.getElementById('lesson-article')) {
  boot().catch((err) => {
    const el = document.getElementById('lesson-article');
    if (el) {
      el.innerHTML = `<div class="lesson-head">
          <p class="lesson-kicker">Problem</p>
          <h1 class="lesson-title">The course content could not be loaded</h1>
        </div>
        <p class="lesson-p">This almost always means the page was opened straight from disk
        (a <code>file://</code> address), which browsers do not allow to read
        <code>content/course.json</code>. Serve the folder with any static server instead —
        <code>python -m http.server</code> or Caddy's <code>file_server</code> will do.</p>`;
      const detail = document.createElement('p');
      detail.className = 'load-error';
      detail.textContent = String(err && err.message ? err.message : err);
      el.appendChild(detail);
    }
    console.error(err);
  });
}
