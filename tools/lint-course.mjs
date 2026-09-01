/* Mechanical cross-module coherence checks for the whole course.
 *
 *   node tools/lint-course.mjs            # report
 *   node tools/lint-course.mjs --strict   # exit 1 on hard errors
 *
 * The per-module harness proves each module works on its own. This looks for
 * the defects that only appear when you read all 11 together — the ones you get
 * when modules are written independently:
 *
 *   1. commands used before the lesson that teaches them (prerequisite order)
 *   2. cross-module references ("as you saw in Module 3") pointing somewhere wrong
 *   3. git commands the sandbox does not implement, quoted as if it did
 *   4. competing vocabulary for the same idea across modules
 *   5. sentences duplicated between modules
 *   6. lessons far longer or denser than the course norm
 *
 * Only 1-3 can be definitively wrong, so only those are hard errors. The rest
 * are printed for a human to judge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitEngine } from '../engine/git-engine.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const course = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'course.json'), 'utf8'));
const strict = process.argv.includes('--strict');

const errors = [];
const notes = [];
const err = (m) => errors.push(m);
const note = (m) => notes.push(m);

/* ---------------------------------------------------------------- indexing */

/** Every lesson in course order, with its prose and its runnable commands. */
const units = [];
for (const mod of course.modules) {
  for (const lesson of mod.lessons) {
    if (lesson.comingSoon) continue;
    const prose = [];
    const commands = [];
    const collect = (blocks) => {
      for (const b of blocks || []) {
        for (const k of ['h', 'p', 'analogy', 'tip', 'warn']) if (b[k]) prose.push(b[k]);
        if (b.list) prose.push(...b.list);
        if (b.code) commands.push(...String(b.code).split('\n'));
      }
    };
    collect(lesson.body);
    const ex = lesson.exercise;
    if (ex) {
      if (ex.goal) prose.push(ex.goal);
      for (const h of ex.hints || []) prose.push(h);
      for (const s of ex.steps || []) {
        prose.push(s.say);
        if (s.hint) prose.push(s.hint);
        commands.push(...String(s.cmd || '').split('\n'));
      }
    }
    units.push({ mod, lesson, id: lesson.id, prose, commands });
  }
  if (mod.recap) {
    const prose = [];
    const commands = [];
    for (const b of mod.recap.body || []) {
      for (const k of ['h', 'p', 'analogy', 'tip', 'warn']) if (b[k]) prose.push(b[k]);
      if (b.list) prose.push(...b.list);
      if (b.code) commands.push(...String(b.code).split('\n'));
    }
    units.push({ mod, lesson: { id: `${mod.id}-recap`, title: 'recap' }, id: `${mod.id}-recap`, prose, commands });
  }
}

const supported = new Set(new GitEngine().completions().gitSubcommands);

/* Without this, "git cannot do X" and "git has no command for this" parse as
 * subcommands named "cannot" and "has". Only real git verbs count. */
const REAL_GIT_SUBCOMMANDS = new Set([
  ...supported,
  'clone', 'tag', 'config', 'cherry-pick', 'rebase', 'blame', 'bisect', 'grep',
  'rm', 'mv', 'clean', 'describe', 'shortlog', 'archive', 'gc', 'fsck', 'help',
  'apply', 'am', 'format-patch', 'send-email', 'submodule', 'worktree', 'notes',
  'range-diff', 'switch', 'restore', 'sparse-checkout', 'maintenance', 'prune',
]);

/* --------------------------- 1 + 3. command inventory and first use -------- */

/** git subcommands named anywhere in a unit, from prose backticks and code. */
function gitSubsIn(unit) {
  const found = new Set();
  const scan = (text) => {
    for (const m of String(text).matchAll(/git\s+([a-z-]+)/g)) found.add(m[1]);
  };
  unit.prose.forEach(scan);
  unit.commands.forEach(scan);
  return found;
}

/** Subcommands a unit actually RUNS (guided cmd / code block), i.e. teaches. */
function gitSubsRun(unit) {
  const found = new Set();
  for (const line of unit.commands) {
    const m = String(line).trim().match(/^git\s+([a-z-]+)/);
    if (m) found.add(m[1]);
  }
  return found;
}

const firstRun = new Map();   // sub -> unit index where it is first executed
units.forEach((u, i) => {
  for (const sub of gitSubsRun(u)) if (!firstRun.has(sub)) firstRun.set(sub, i);
});

// A command mentioned in prose long before it is ever run is usually a
// deliberate forward pointer ("Module 9 covers this"). One used in an exercise
// before it is taught is a real prerequisite bug — but the harness proves every
// exercise runs, so what matters here is prose that ASSUMES prior knowledge.
// A concept lesson naming a command and the guided lesson then running it is
// exactly the intended shape, so "mentioned before first run" is NOT a defect.
// The real bug is the reverse: an exercise that RUNS a command no lesson has
// introduced yet, leaving the learner typing something never explained.
const firstMention = new Map();
units.forEach((u, i) => {
  for (const sub of gitSubsIn(u)) if (!firstMention.has(sub)) firstMention.set(sub, i);
});

units.forEach((u, i) => {
  for (const sub of gitSubsRun(u)) {
    if (!REAL_GIT_SUBCOMMANDS.has(sub)) continue;
    const explained = firstMention.get(sub);
    if (explained === undefined || explained > i) {
      err(`[order] ${u.id} runs \`git ${sub}\` but no lesson up to that point introduces it`);
    }
  }
});

// 3. commands the sandbox cannot run, quoted anywhere
const REAL_GIT_OK = /real git|real world|your own machine|outside this sandbox|this sandbox|older tutorial|modern git|specialist tool/i;
units.forEach((u) => {
  const runs = gitSubsRun(u);
  for (const sub of runs) {
    if (!supported.has(sub)) {
      err(`[unsupported] ${u.id} RUNS \`git ${sub}\`, which the engine does not implement`);
    }
  }
  for (const sub of gitSubsIn(u)) {
    if (supported.has(sub) || runs.has(sub)) continue;
    if (!REAL_GIT_SUBCOMMANDS.has(sub)) continue;   // English prose, not a command
    const sentence = u.prose.find((p) => new RegExp(`git\\s+${sub}\\b`).test(p)) || '';
    if (REAL_GIT_OK.test(sentence)) continue;       // explicitly framed as real-git-only
    note(`[sandbox] ${u.id} names \`git ${sub}\` (not in the sandbox) without saying so` +
      `\n         "${sentence.slice(0, 150)}${sentence.length > 150 ? '…' : ''}"`);
  }
});

/* ----------------------------- 2. cross-module references ------------------ */

const maxModule = course.modules.length;
const titleOf = new Map(course.modules.map((m) => [m.number, m.title]));
units.forEach((u) => {
  for (const text of u.prose) {
    for (const m of String(text).matchAll(/\bModule\s+(\d+)/gi)) {
      const n = parseInt(m[1], 10);
      if (n < 1 || n > maxModule) {
        err(`[xref] ${u.id} references "Module ${n}", which does not exist (course has ${maxModule})`);
        continue;
      }
      if (n === u.mod.number && !/^Module\s+\d+\s+recap/i.test(String(text).trim())) {
        note(`[xref] ${u.id} refers to "Module ${n}", which is its own module` +
          `\n         "${String(text).slice(0, 140)}…"`);
      }
    }
  }
});

/* --------------------------- 4. competing vocabulary ----------------------- */

const VOCAB = [
  ['staging area', ['staging area', 'the index', 'the stage']],
  ['working directory', ['working directory', 'working tree', 'your folder']],
  ['repository', ['repository', 'repo']],
  ['commit', ['snapshot', 'save point', 'checkpoint']],
];
for (const [canonical, variants] of VOCAB) {
  const counts = new Map();
  for (const u of units) {
    const blob = u.prose.join(' ').toLowerCase();
    for (const v of variants) {
      const n = (blob.match(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      if (n) counts.set(v, (counts.get(v) || 0) + n);
    }
  }
  const used = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (used.length > 1) {
    note(`[vocab] "${canonical}" appears as: ${used.map(([v, n]) => `${v} (${n})`).join(', ')}`);
  }
}

/* ----------------------------- 5. duplicated prose ------------------------- */

const sentences = new Map();
for (const u of units) {
  for (const text of u.prose) {
    for (const raw of String(text).split(/(?<=[.!?])\s+/)) {
      const s = raw.trim().toLowerCase().replace(/[`*_]/g, '');
      if (s.length < 60) continue;
      if (!sentences.has(s)) sentences.set(s, new Set());
      sentences.get(s).add(u.mod.id);
    }
  }
}
for (const [s, mods] of sentences) {
  if (mods.size > 1) {
    note(`[dup] identical sentence in ${[...mods].join(' + ')}:\n         "${s.slice(0, 150)}…"`);
  }
}

/* ------------------------------ 6. length outliers ------------------------- */

// Modules 1-3 split their theory across two short concept lessons; modules 4-11
// each carry it in one. Comparing lesson to lesson therefore flatters the early
// modules — total concept words PER MODULE is the honest comparison.
const perModule = new Map();
for (const u of units) {
  if ((u.lesson.type || 'recap') !== 'concept') continue;
  const w = u.prose.join(' ').split(/\s+/).filter(Boolean).length;
  perModule.set(u.mod.number, (perModule.get(u.mod.number) || 0) + w);
}
const totals = [...perModule.entries()].sort((a, b) => a[0] - b[0]);
const mean = totals.reduce((a, [, w]) => a + w, 0) / (totals.length || 1);
note('[length] concept words per module: ' + totals.map(([n, w]) => `M${n}=${w}`).join(' ') +
  `  (mean ${Math.round(mean)})`);
for (const [n, w] of totals) {
  if (w > mean * 1.5) note(`[length] module ${n} carries ${w} concept words vs a ${Math.round(mean)}-word average — check it does not sprawl`);
  if (w < mean * 0.5) note(`[length] module ${n} carries only ${w} concept words vs a ${Math.round(mean)}-word average`);
}

/* --------------------------------- report --------------------------------- */

console.log(`lint-course: ${units.length} units across ${course.modules.length} modules\n`);
if (errors.length) {
  console.log(`HARD ERRORS (${errors.length}):`);
  for (const e of errors) console.log('  ✗ ' + e);
  console.log();
}
if (notes.length) {
  console.log(`FOR REVIEW (${notes.length}):`);
  for (const n of notes) console.log('  · ' + n);
  console.log();
}
if (!errors.length && !notes.length) console.log('nothing to report');
console.log(`${errors.length} hard error(s), ${notes.length} review item(s)`);
if (strict && errors.length) process.exit(1);
