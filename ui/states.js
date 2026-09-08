/* ============================================================================
 * first-commit — state reference
 * ----------------------------------------------------------------------------
 * Every state §5 of the rebuild brief asks for, on one page, at `#/states`.
 *
 * Each plate is the live component driven by a real engine, not a picture of
 * one: the graphs and file panels below are produced by running actual commands
 * through GitEngine and handing the snapshot to the same renderer the exercises
 * use. So this page cannot drift from the product — if a state regresses here,
 * it regressed there.
 * ========================================================================== */

import { GitEngine } from '../engine/git-engine.js';
import { renderGraph } from './graph.js';
import { renderFiles } from './filetree.js';
import { Terminal } from './terminal.js';
import { icon } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An engine that has really run `cmds`. Nothing here is hand-built state. */
function engineFrom(cmds) {
  const e = new GitEngine();
  for (const c of cmds) e.run(c);
  return e;
}

const commit = (name, body) => [`echo "${body}" > ${name}`, 'git add .', `git commit -m "Add ${name}"`];

const SEQ = {
  none: [],
  init: ['git init'],
  linear: ['git init', ...commit('a.txt', 'one'), ...commit('b.txt', 'two'), ...commit('c.txt', 'three')],
  diverged: [
    'git init', ...commit('a.txt', 'one'),
    'git switch -c add-faq', ...commit('faq.md', 'q'),
    'git switch main', ...commit('b.txt', 'two'),
  ],
  merged: [
    'git init', ...commit('a.txt', 'one'),
    'git switch -c add-faq', ...commit('faq.md', 'q'),
    'git switch main', ...commit('b.txt', 'two'),
    'git merge add-faq',
  ],
  detached: ['git init', ...commit('a.txt', 'one'), ...commit('b.txt', 'two'), 'git checkout HEAD~1'],
  remote: [
    'git init', ...commit('a.txt', 'one'), ...commit('b.txt', 'two'),
    'git remote add origin https://github.com/you/demo.git', 'git push -u origin main',
    ...commit('c.txt', 'three'),
  ],
  conflicted: [
    'git init', 'echo "original" > f.txt', 'git add .', 'git commit -m "Start"',
    'git switch -c hotfix', 'echo "theirs" > f.txt', 'git add .', 'git commit -m "Theirs"',
    'git switch main', 'echo "mine" > f.txt', 'git add .', 'git commit -m "Mine"',
    'git merge hotfix',
  ],
  fourRefs: [
    'git init', ...commit('a.txt', 'one'),
    'git remote add origin https://github.com/you/demo.git', 'git push -u origin main',
    'git switch -c add-faq', ...commit('faq.md', 'q'),
    'git switch main', 'git switch -c trip-reports', ...commit('trip.md', 't'),
    'git switch main',
  ],
  overflow: ['git init', ...Array.from({ length: 12 }, (_, i) => commit(`f${i + 1}.txt`, 'x')).flat()],
  threeAreas: [
    'git init', ...commit('recipe.txt', 'pancakes'),
    'echo "draft" > notes.md', 'git add notes.md',
    'echo "more" >> recipe.txt',
    'echo "scratch" > scratch.tmp',
  ],
  everyState: [
    'git init',
    'echo "kept" > kept.txt', 'echo "gone" > gone.txt', 'echo "edited" > edited.txt',
    'git add .', 'git commit -m "Baseline"',
    'echo "changed" >> edited.txt',
    'rm gone.txt',
    'echo "brand new" > fresh.txt', 'git add fresh.txt',
    'echo "nobody tracks me" > loose.txt',
    'echo "*.log" > .gitignore', 'echo "noise" > debug.log',
  ],
  nested: [
    'git init', ...commit('index.html', 'hi'),
    'echo "<h1>gallery</h1>" > site/gallery.html',
    'echo "module.exports=1" > node_modules/left-pad.js',
    'git add site/gallery.html',
  ],
};

/* --------------------------------- plates -------------------------------- */

function plate(label, bodyHeight) {
  const wrap = document.createElement('div');
  wrap.className = 'plate';
  const head = document.createElement('div');
  head.className = 'plate-head';
  const name = document.createElement('span');
  name.className = 'plate-label';
  name.textContent = label;
  head.appendChild(name);
  const body = document.createElement('div');
  body.className = 'plate-body';
  if (bodyHeight) body.style.height = bodyHeight;
  wrap.append(head, body);
  return { wrap, body, head };
}

function graphPlate(label, cmds) {
  const { wrap, body } = plate(label, '200px');
  const svg = document.createElementNS(SVG_NS, 'svg');
  const drawn = renderGraph(svg, engineFrom(cmds).getGraph());
  body.classList.add('plate-scroll');
  if (drawn.empty) body.classList.add('plate-centre');
  body.appendChild(svg);
  return wrap;
}

function filePlate(label, cmds) {
  const { wrap, body } = plate(label, '300px');
  body.classList.add('plate-scroll');
  const panel = document.createElement('div');
  renderFiles(panel, engineFrom(cmds).getFileState());
  body.appendChild(panel);
  return wrap;
}

/** A real Terminal, printing sample output. Nothing is typed into these. */
function terminalPlate(prompt, lines) {
  const host = document.createElement('div');
  host.className = 'plate-terminal';
  const term = new Terminal(host, { onCommand: () => {}, promptText: () => prompt });
  for (const [text, kind] of lines) {
    if (kind === 'cmd') term.echo(text);
    else term.print(text, kind);
  }
  return host;
}

/* ---------------------------- chrome row plates --------------------------- */

function stepRow(state, label) {
  const li = document.createElement('li');
  li.className = 'step step-' + state;
  li.innerHTML = '<span class="step-marker" aria-hidden="true"></span>' +
    '<div class="step-body"><div class="step-say"></div></div>';
  li.querySelector('.step-marker').textContent = state === 'done' ? '✓' : state === 'current' ? '2' : '3';
  li.querySelector('.step-say').textContent = label;
  return li;
}

function checkRow(passed, label) {
  const li = document.createElement('li');
  li.className = 'check-item' + (passed ? ' check-pass' : '');
  li.innerHTML = '<span class="check-box" aria-hidden="true"></span>' +
    '<span class="check-label"></span><span class="check-state"></span>';
  li.querySelector('.check-box').textContent = passed ? '✓' : '';
  li.querySelector('.check-label').textContent = label;
  li.querySelector('.check-state').textContent = passed ? 'met' : 'waiting';
  return li;
}

function navRow(mark, label, cls) {
  const li = document.createElement('li');
  const a = document.createElement('span');
  a.className = 'nav-lesson ' + cls;
  a.innerHTML = '<span class="nav-icon" aria-hidden="true"></span><span class="nav-title"></span>';
  a.querySelector('.nav-icon').textContent = mark;
  a.querySelector('.nav-title').textContent = label;
  li.appendChild(a);
  return li;
}

function rowPlate(label, rows, listClass) {
  const { wrap, body } = plate(label);
  body.classList.add('plate-rows');
  const ul = document.createElement('ul');
  ul.className = listClass;
  for (const r of rows) ul.appendChild(r);
  body.appendChild(ul);
  return wrap;
}

/* --------------------------------- sections ------------------------------- */

function section(container, title, plates, minCol) {
  const h = document.createElement('h2');
  h.className = 'states-h';
  h.textContent = title;
  const grid = document.createElement('div');
  grid.className = 'plate-grid';
  grid.style.setProperty('--plate-min', minCol);
  for (const p of plates) grid.appendChild(p);
  container.append(h, grid);
}

/**
 * @param {HTMLElement} container  where the page is built (the lesson article)
 */
export function renderStates(container) {
  const head = document.createElement('div');
  head.className = 'lesson-head';
  head.innerHTML = '<p class="lesson-kicker">Review checklist</p>' +
    '<h1 class="lesson-title">Every state, defined.</h1>';
  const sub = document.createElement('p');
  sub.className = 'states-sub';
  sub.textContent = 'Each plate below is the live component, not a picture of one — the same ' +
    'renderers the exercises use, driven by an engine that really ran the commands.';
  head.appendChild(sub);
  container.appendChild(head);

  section(container, 'Commit graph', [
    graphPlate('No repository', SEQ.none),
    graphPlate('Initialised, no commits', SEQ.init),
    graphPlate('Linear history', SEQ.linear),
    graphPlate('Diverged branches', SEQ.diverged),
    graphPlate('Merge commit', SEQ.merged),
    graphPlate('Detached HEAD', SEQ.detached),
    graphPlate('Remote refs', SEQ.remote),
    graphPlate('Merge in progress', SEQ.conflicted),
    graphPlate('Four ref labels at once', SEQ.fourRefs),
    graphPlate('Overflow — scrolls, HEAD kept in view', SEQ.overflow),
  ], '316px');

  section(container, 'File state', [
    filePlate('No repository', SEQ.none),
    filePlate('Three areas', SEQ.threeAreas),
    filePlate('Every area empty', SEQ.init),
    filePlate('Every file state', SEQ.everyState),
    filePlate('Nested paths', SEQ.nested),
    filePlate('Conflict', SEQ.conflicted),
  ], '296px');

  section(container, 'Terminal', [
    terminalPlate('~/project (main) $', [
      ['git status', 'cmd'],
      ['On branch main', 'plain'],
      ['Changes to be committed:', null],
      ['\tnew file:   recipe.txt', null],
      ['Untracked files:', null],
      ['\tscratch.tmp', null],
      ['  (use "git add <file>..." to include in what will be committed)', null],
    ]),
    terminalPlate('~/project (main|MERGING) $', [
      ['git merge hotfix', 'cmd'],
      ['Auto-merging f.txt', 'plain'],
      ['CONFLICT (content): Merge conflict in f.txt', null],
      ['Automatic merge failed; fix conflicts and then commit the result.', 'plain'],
      ['fatal: not a git repository', null],
      ['3f9a1c2 Add the pancake recipe', null],
      ['@@ -1,4 +1,5 @@', null],
      ['+a line that was added', null],
      ['-a line that was removed', null],
    ]),
    terminalPlate('~/project (HEAD detached) $', [
      ['git log --oneline', 'cmd'],
      ['a3f9e21 Add the pancake recipe', null],
      ['7c1d0b4 Start the notes', null],
      ['git comm', 'cmd'],
      ['commit  commit-tree', 'dim'],
    ]),
  ], '336px');

  const stepList = [stepRow('done', 'Run ls to look around'),
    stepRow('current', 'Stage the file with git add recipe.txt'),
    stepRow('future', 'Commit it with a message')];
  const checkList = [checkRow(true, 'Repository initialised'),
    checkRow(false, 'recipe.txt is staged'),
    checkRow(false, 'The commit message describes what changed, in the imperative mood, and is under fifty characters')];
  const navList = [navRow('·', 'The problem Git solves', 'done'),
    navRow('›', 'Guided: your first commit', 'active'),
    navRow('◇', 'Challenge: from folder to first commit', ''),
    navRow('≡', 'Module recap', ''),
    navRow('◌', 'Rebasing (being written)', 'nav-soon')];

  section(container, 'Steps, checks and navigation', [
    rowPlate('Guided step — done, current, upcoming', stepList, 'step-list'),
    rowPlate('Challenge condition — met, waiting, long label', checkList, 'check-list'),
    rowPlate('Lesson — four types, done, current, coming soon', navList, 'nav-lessons'),
  ], '316px');

  /* Controls are stateful too, and the disabled/confirming ones are the easiest
     to ship broken because they are never seen during a normal run. */
  const { wrap, body } = plate('Controls');
  body.classList.add('plate-controls');
  const buttons = [
    ['btn btn-solid btn-lg', 'Continue', 'arrow-right'],
    ['btn btn-sm', 'Run it for me', 'play'],
    ['btn btn-sm btn-quiet', 'Reveal a hint (3 available)', 'lightbulb'],
    ['btn btn-sm btn-quiet', 'No hints left', 'lightbulb', true],
    ['btn btn-sm btn-ghost', 'reset', 'reset'],
    ['btn btn-sm btn-danger', 'Tap again to erase 12 completed', null],
  ];
  for (const [cls, label, ic, disabled] of buttons) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    // arrow-right reads as "and then…", so it trails the label; the rest lead.
    if (ic === 'arrow-right') b.append(label, icon(ic));
    else if (ic) b.append(icon(ic), label);
    else b.append(label);
    if (disabled) b.disabled = true;
    body.appendChild(b);
  }
  const grid = document.createElement('div');
  grid.className = 'plate-grid';
  grid.style.setProperty('--plate-min', '316px');
  grid.appendChild(wrap);
  const h = document.createElement('h2');
  h.className = 'states-h';
  h.textContent = 'Controls';
  container.append(h, grid);
}

export default renderStates;
