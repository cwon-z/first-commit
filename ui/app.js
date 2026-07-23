/* ============================================================================
 * first-commit — application controller
 * ----------------------------------------------------------------------------
 * Wires content (course.json) + engine (GitEngine) + UI components together.
 * Routing is hash-based (#/lesson/<id>, #/playground) so the app deploys as
 * plain static files behind any server (Caddy, nginx, python -m http.server).
 * ========================================================================== */

import { GitEngine } from '../engine/git-engine.js';
import { runChecks, allPassed } from '../engine/validators.js';
import { Terminal } from './terminal.js';
import { renderGraph } from './graph.js';
import { renderFiles } from './filetree.js';
import { renderBlocks } from './lesson.js';
import { LocalStorageProgressStore } from './progress.js';

/* ★ BACKEND SEAM: swap this single line for a RestProgressStore(baseUrl, token)
 *   when accounts/server-side progress arrive. See ui/progress.js.            */
const store = new LocalStorageProgressStore();

const S = {
  course: null,
  progress: null,
  entries: [],       // flattened [{module, lesson}]
  current: null,     // current entry
  engine: null,
  terminal: null,
  stepIdx: 0,
  revealedHints: 0,
  completedThisView: false,
};

const $ = (sel) => document.querySelector(sel);

/* ------------------------------- bootstrap ------------------------------- */

async function boot() {
  const res = await fetch('./content/course.json');
  S.course = await res.json();
  S.progress = await store.load();
  document.title = `${S.course.meta.brand} — interactive Git course`;
  $('#brand-name').textContent = S.course.meta.brand;
  buildSidebar();
  window.addEventListener('hashchange', route);
  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#sidebar-scrim').addEventListener('click', () => $('#sidebar').classList.remove('open'));
  route();
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

function buildSidebar() {
  S.entries = flatten();
  const nav = $('#module-nav');
  nav.innerHTML = '';
  for (const mod of S.course.modules) {
    const details = document.createElement('details');
    details.className = 'nav-module';
    details.dataset.mod = mod.id;
    if (mod.status === 'ready') details.open = true;

    const summary = document.createElement('summary');
    const modDone = S.entries
      .filter((e) => e.module.id === mod.id && !e.lesson.comingSoon)
      .every((e) => isDone(e.lesson.id));
    summary.innerHTML = `<span class="nav-mod-num">${String(mod.number).padStart(2, '0')}</span>
      <span class="nav-mod-title"></span>
      <span class="nav-mod-badge"></span>`;
    summary.querySelector('.nav-mod-title').textContent = mod.title;
    const badge = summary.querySelector('.nav-mod-badge');
    if (mod.status !== 'ready') { badge.textContent = 'soon'; badge.classList.add('badge-soon'); }
    else if (modDone) { badge.textContent = '✓'; badge.classList.add('badge-done'); }
    details.appendChild(summary);

    const ul = document.createElement('ul');
    ul.className = 'nav-lessons';
    for (const entry of S.entries.filter((e) => e.module.id === mod.id)) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#/lesson/${entry.lesson.id}`;
      a.dataset.lesson = entry.lesson.id;
      a.className = 'nav-lesson';
      if (entry.lesson.comingSoon) a.classList.add('nav-soon');
      const icon = entry.lesson.comingSoon ? '◌'
        : isDone(entry.lesson.id) ? '✓'
        : entry.lesson.type === 'challenge' ? '⚑'
        : entry.lesson.type === 'guided' ? '▸' : '·';
      a.innerHTML = `<span class="nav-icon"></span><span class="nav-title"></span>`;
      a.querySelector('.nav-icon').textContent = icon;
      a.querySelector('.nav-title').textContent = entry.lesson.title;
      if (isDone(entry.lesson.id)) a.classList.add('done');
      a.addEventListener('click', () => $('#sidebar').classList.remove('open'));
      li.appendChild(a);
      ul.appendChild(li);
    }
    details.appendChild(ul);
    nav.appendChild(details);
  }

  const pg = document.createElement('a');
  pg.href = '#/playground';
  pg.className = 'nav-playground';
  pg.innerHTML = '<span class="nav-icon">∞</span> Playground — free sandbox';
  pg.addEventListener('click', () => $('#sidebar').classList.remove('open'));
  nav.appendChild(pg);

  updateProgressPill();
}

function updateProgressPill() {
  const playable = playableEntries();
  const done = playable.filter((e) => isDone(e.lesson.id)).length;
  const pct = playable.length ? Math.round((done / playable.length) * 100) : 0;
  $('#progress-pill').textContent = `${done}/${playable.length} · ${pct}%`;
  $('#progress-bar-fill').style.width = pct + '%';
}

function markActive(lessonId) {
  document.querySelectorAll('.nav-lesson').forEach((a) => {
    a.classList.toggle('active', a.dataset.lesson === lessonId);
  });
}

/* -------------------------------- routing -------------------------------- */

function route() {
  const hash = location.hash || '';
  const m = hash.match(/^#\/lesson\/([\w-]+)/);
  if (m) {
    const entry = S.entries.find((e) => e.lesson.id === m[1]);
    if (entry) { show(entry); return; }
  }
  if (hash.startsWith('#/playground')) { showPlayground(); return; }
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

function show(entry) {
  S.current = entry;
  S.completedThisView = false;
  S.progress.lastLessonId = entry.lesson.id;
  store.save(S.progress);
  markActive(entry.lesson.id);

  const { module: mod, lesson } = entry;
  $('#crumb').textContent = `Module ${mod.number} · ${mod.title}`;
  const article = $('#lesson-article');
  article.innerHTML = '';

  const kicker = document.createElement('div');
  kicker.className = 'lesson-kicker';
  kicker.textContent = { concept: 'Concept', guided: 'Guided exercise', challenge: 'Challenge', recap: 'Recap' }[lesson.type] || 'Lesson';
  const h1 = document.createElement('h2');
  h1.className = 'lesson-title';
  h1.textContent = lesson.title;
  article.append(kicker, h1);

  if (lesson.comingSoon) {
    renderComingSoon(article, mod);
    hideWorkspace();
    return;
  }

  renderBlocks(article, lesson.body || [], { graphFromOps });

  if (lesson.type === 'concept' || lesson.type === 'recap') {
    hideWorkspace();
    article.appendChild(continueControls(entry, lesson.type === 'recap' ? 'Finish module' : 'Got it — continue'));
  } else if (lesson.type === 'guided') {
    setupWorkspace(entry, 'guided');
  } else if (lesson.type === 'challenge') {
    setupWorkspace(entry, 'challenge');
  }
  $('#lesson-pane').scrollTop = 0;
}

function renderComingSoon(article, mod) {
  const d = document.createElement('div');
  d.className = 'coming-soon-card';
  d.innerHTML = `<p class="cs-emoji">🚧</p>
    <p class="cs-text">This lesson is being filmed and written. The module will cover:</p>
    <p class="cs-summary"></p>
    <p class="cs-note">The sandbox already supports these commands — try them in the <a href="#/playground">Playground</a>.</p>`;
  d.querySelector('.cs-summary').textContent = mod.summary;
  article.appendChild(d);
}

function continueControls(entry, label) {
  const wrap = document.createElement('div');
  wrap.className = 'lesson-actions';
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.textContent = isDone(entry.lesson.id) ? 'Continue →' : label + ' →';
  btn.addEventListener('click', () => {
    completeLesson(entry.lesson.id, false);
    gotoNext(entry);
  });
  wrap.appendChild(btn);
  return wrap;
}

function gotoNext(entry) {
  const playable = playableEntries();
  const idx = playable.findIndex((e) => e.lesson.id === entry.lesson.id);
  const next = playable[idx + 1];
  if (next) location.hash = `#/lesson/${next.lesson.id}`;
}

function completeLesson(lessonId, celebrate = true) {
  if (!isDone(lessonId)) {
    S.progress.completedLessons.push(lessonId);
    store.save(S.progress);
    buildSidebar();
    markActive(lessonId);
  }
  if (celebrate && !S.completedThisView) {
    S.completedThisView = true;
    showSuccessBanner();
  }
}

function showSuccessBanner() {
  const old = $('#success-banner');
  if (old) old.remove();
  const banner = document.createElement('div');
  banner.id = 'success-banner';
  banner.innerHTML = `<div class="sb-inner">
      <span class="sb-check">✓</span>
      <div><strong>Exercise complete!</strong><br><span class="sb-sub">Repo state verified — nicely done.</span></div>
      <button class="btn btn-primary" id="sb-next">Continue →</button>
    </div>`;
  $('#lesson-article').appendChild(banner);
  banner.querySelector('#sb-next').addEventListener('click', () => gotoNext(S.current));
  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ------------------------------- workspace ------------------------------- */

function hideWorkspace() {
  $('#workspace').classList.add('hidden');
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
  $('#workspace').classList.remove('hidden');
  S.engine = new GitEngine();
  S.engine.applySetup(ex.setup || []);
  S.stepIdx = 0;
  S.revealedHints = 0;

  // exercise panel
  const panel = $('#exercise-panel');
  panel.innerHTML = '';
  if (mode === 'guided') renderGuidedPanel(panel, entry);
  else if (mode === 'challenge') renderChallengePanel(panel, entry);
  else renderPlaygroundPanel(panel);

  // terminal
  const termRoot = $('#terminal');
  S.terminal = new Terminal(termRoot, {
    promptText,
    completer: () => S.engine.completions(),
    onCommand: (line) => handleCommand(line, entry, mode),
  });
  S.terminal.print('Sandbox ready. This terminal simulates git — nothing here touches your computer.', 'dim');
  S.terminal.print("Type 'help' for available commands." + (mode !== 'playground' ? " Type 'hint' if you're stuck." : ''), 'dim');
  S.terminal.printBlank();

  $('#reset-btn').onclick = () => {
    setupWorkspace(entry, mode);
  };

  updateVisuals();
  if (window.matchMedia('(min-width: 900px)').matches) S.terminal.focus();
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
  const svg = $('#graph-svg');
  renderGraph(svg, S.engine.getGraph());
  const scroller = $('#graph-scroll');
  scroller.scrollLeft = scroller.scrollWidth;
  renderFiles($('#files-panel'), S.engine.getFileState());
  const headline = $('#graph-headline');
  const head = S.engine.headCommit();
  headline.textContent = head ? `HEAD: ${head.message}` : '';
}

/* ------------------------------ guided mode ------------------------------ */

function renderGuidedPanel(panel, entry) {
  const steps = entry.lesson.exercise.steps;
  const wrap = document.createElement('div');
  wrap.className = 'guided-steps';
  const head = document.createElement('div');
  head.className = 'ex-head';
  head.innerHTML = `<span class="ex-tag ex-tag-guided">guided</span><span class="ex-progress" id="guided-progress"></span>`;
  wrap.appendChild(head);
  const ol = document.createElement('ol');
  ol.className = 'step-list';
  ol.id = 'step-list';
  steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.className = 'step';
    li.dataset.idx = i;
    li.innerHTML = `
      <div class="step-marker"></div>
      <div class="step-body">
        <div class="step-say"></div>
        ${step.cmd ? '<pre class="step-cmd"><code></code></pre>' : ''}
        <button class="step-hint-btn hidden-btn" type="button">show hint</button>
        <div class="step-hint" hidden></div>
      </div>`;
    li.querySelector('.step-say').innerHTML = mdLite(step.say);
    if (step.cmd) li.querySelector('.step-cmd code').textContent = step.cmd;
    const hintBtn = li.querySelector('.step-hint-btn');
    const hintEl = li.querySelector('.step-hint');
    hintEl.textContent = step.hint || '';
    if (step.hint) {
      hintBtn.classList.remove('hidden-btn');
      hintBtn.addEventListener('click', () => { hintEl.hidden = !hintEl.hidden; hintBtn.textContent = hintEl.hidden ? 'show hint' : 'hide hint'; });
    }
    ol.appendChild(li);
  });
  wrap.appendChild(ol);
  panel.appendChild(wrap);
  refreshGuidedUI(entry);
}

function mdLite(s) {
  // escape + minimal inline markup (same rules as lesson renderer)
  const esc = String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return esc.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
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
  const prog = $('#guided-progress');
  if (prog) prog.textContent = `step ${Math.min(S.stepIdx + 1, steps.length)} of ${steps.length}`;
  const current = document.querySelector('#step-list .step-current');
  if (current) current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function checkGuided(entry) {
  const steps = entry.lesson.exercise.steps;
  if (S.stepIdx >= steps.length) return;
  const res = runChecks(S.engine, steps[S.stepIdx].expect);
  if (allPassed(res)) {
    S.stepIdx++;
    refreshGuidedUI(entry);
    if (S.stepIdx >= steps.length) {
      completeLesson(entry.lesson.id);
    }
  }
}

function revealHint(entry, mode) {
  if (mode === 'guided') {
    const step = entry.lesson.exercise.steps[S.stepIdx];
    if (step && step.hint) S.terminal.print('hint: ' + step.hint, 'dim');
    else S.terminal.print('hint: follow the current step in the panel above.', 'dim');
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

function renderChallengePanel(panel, entry) {
  const ex = entry.lesson.exercise;
  const wrap = document.createElement('div');
  wrap.className = 'challenge-panel';
  const head = document.createElement('div');
  head.className = 'ex-head';
  head.innerHTML = `<span class="ex-tag ex-tag-challenge">challenge</span><span class="ex-progress" id="challenge-progress"></span>`;
  wrap.appendChild(head);

  const goal = document.createElement('div');
  goal.className = 'challenge-goal';
  goal.innerHTML = `<div class="goal-label">Your mission</div><p></p>`;
  goal.querySelector('p').innerHTML = mdLite(ex.goal);
  wrap.appendChild(goal);

  const list = document.createElement('ul');
  list.className = 'check-list';
  list.id = 'check-list';
  ex.expect.forEach((check, i) => {
    const li = document.createElement('li');
    li.className = 'check-item';
    li.dataset.idx = i;
    li.innerHTML = `<span class="check-box"></span><span class="check-label"></span>`;
    li.querySelector('.check-label').textContent = check.label || check.kind;
    list.appendChild(li);
  });
  wrap.appendChild(list);

  if (ex.hints && ex.hints.length) {
    const hintWrap = document.createElement('div');
    hintWrap.className = 'challenge-hints';
    hintWrap.id = 'challenge-hints';
    wrap.appendChild(hintWrap);
  }
  panel.appendChild(wrap);
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
    d.innerHTML = `<span class="hint-num">hint ${i + 1}</span> <span class="hint-text"></span>`;
    d.querySelector('.hint-text').textContent = h;
    hintWrap.appendChild(d);
  });
  if (S.revealedHints < hints.length) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-hint';
    btn.textContent = S.revealedHints === 0
      ? `Stuck? Reveal a hint (${hints.length} available)`
      : `Reveal another hint (${hints.length - S.revealedHints} left)`;
    btn.addEventListener('click', () => { S.revealedHints++; refreshHintButtons(entry); });
    hintWrap.appendChild(btn);
  }
}

function refreshChecklist(entry) {
  const res = runChecks(S.engine, entry.lesson.exercise.expect);
  document.querySelectorAll('#check-list .check-item').forEach((li) => {
    const i = Number(li.dataset.idx);
    li.classList.toggle('check-pass', res[i].passed);
  });
  const passedCount = res.filter((r) => r.passed).length;
  const prog = $('#challenge-progress');
  if (prog) prog.textContent = `${passedCount}/${res.length} goals`;
  return res;
}

function checkChallenge(entry) {
  const res = refreshChecklist(entry);
  if (allPassed(res)) completeLesson(entry.lesson.id);
}

/* ------------------------------- playground ------------------------------- */

function showPlayground() {
  S.current = null;
  markActive('');
  $('#crumb').textContent = 'Playground';
  const article = $('#lesson-article');
  article.innerHTML = `
    <div class="lesson-kicker">Sandbox</div>
    <h2 class="lesson-title">Playground</h2>
    <p class="lesson-p">A free sandbox with every supported command and no goals. Experiment fearlessly —
    the graph and file panels update live, and the <strong>Reset</strong> button gives you a fresh folder.
    A simulated remote is available: <code>git remote add origin https://github.com/you/demo.git</code>, then push away.</p>`;

  const entry = { module: { number: '∞', title: 'Playground' }, lesson: { id: 'playground', exercise: { setup: [
    { op: 'write', path: 'readme.md', content: '# playground\nAnything goes here.' },
  ] } } };
  setupWorkspace(entry, 'playground');
}

function renderPlaygroundPanel(panel) {
  panel.innerHTML = `<div class="ex-head"><span class="ex-tag ex-tag-playground">free play</span>
    <span class="ex-progress">no goals — just you and the graph</span></div>
    <div class="playground-ideas">
      <div class="goal-label">Ideas to try</div>
      <ul class="lesson-list">
        <li><code>git init</code> → make commits → <code>git log --oneline</code></li>
        <li><code>git switch -c experiment</code> → commit → <code>git switch main</code> → <code>git merge experiment</code></li>
        <li>Edit the same line on two branches, merge, and resolve your first conflict</li>
        <li><code>git reset --hard HEAD~1</code> then <code>git reflog</code> to see where HEAD has been</li>
      </ul>
    </div>`;
}

/* --------------------------------- start --------------------------------- */

if (typeof document !== 'undefined' && document.getElementById('lesson-article')) {
  boot().catch((err) => {
    const el = document.getElementById('lesson-article');
    if (el) {
      el.innerHTML = '<h2 class="lesson-title">Failed to load course</h2><p class="lesson-p">' +
        'The course content could not be loaded. If you opened this file directly (file://), ' +
        'please serve the folder with any static server instead, e.g. <code>python -m http.server</code> ' +
        'or Caddy <code>file_server</code>.</p>';
    }
    console.error(err);
  });
}
