/* Validate one drafted module before it is merged into the course.
 *
 *   node tools/check-module.mjs drafts/module-4.json
 *
 * The draft file is:
 *   {
 *     "module":    { ...one entry of course.json's `modules` array... },
 *     "solutions": { "<challenge lesson id>": ["git init", "git add .", ...] }
 *   }
 *
 * It does three things:
 *   1. splices the module into a copy of the real course.json and runs the
 *      full content test against it (schema, block kinds, check kinds, setup
 *      ops, "not already solved", guided-walkthrough replay);
 *   2. proves every challenge is actually SOLVABLE by replaying its recorded
 *      solution commands through the engine and asserting the checks pass;
 *   3. replays each guided walkthrough and prints the terminal transcript, so
 *      an author can eyeball what the learner will really see.
 *
 * Exit code 0 means the module is ready to merge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GitEngine } from '../engine/git-engine.js';
import { runChecks, allPassed, advanceSteps } from '../engine/validators.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const draftPath = process.argv[2];
const verbose = process.argv.includes('--verbose');

if (!draftPath) {
  console.error('usage: node tools/check-module.mjs <draft.json> [--verbose]');
  process.exit(2);
}

let draft;
try {
  draft = JSON.parse(fs.readFileSync(path.resolve(draftPath), 'utf8'));
} catch (err) {
  console.error(`✗ ${draftPath} is not valid JSON: ${err.message}`);
  process.exit(1);
}

const mod = draft.module;
const solutions = draft.solutions || {};
if (!mod || typeof mod.id !== 'string') {
  console.error('✗ draft must have a "module" object with an "id"');
  process.exit(1);
}

let problems = 0;
const fail = (msg) => { problems++; console.error('✗ ' + msg); };
const pass = (msg) => console.log('✓ ' + msg);

/* ---------- 1. splice into the course and run the content test ---------- */

const course = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'course.json'), 'utf8'));
const idx = course.modules.findIndex((m) => m.id === mod.id);
if (idx === -1) {
  console.error(`✗ no module with id "${mod.id}" in content/course.json`);
  process.exit(1);
}
course.modules[idx] = mod;

const outDir = path.join(ROOT, 'drafts', '.candidates');
fs.mkdirSync(outDir, { recursive: true });
const candidate = path.join(outDir, `course-${mod.id}.json`);
fs.writeFileSync(candidate, JSON.stringify(course, null, 2));

try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tests', 'content.test.js'), candidate], {
    cwd: ROOT, encoding: 'utf8',
  });
  pass(`content test passes with ${mod.id} spliced in — ${out.trim().split('\n').pop()}`);
} catch (err) {
  problems++;
  console.error('✗ content test FAILED with this module spliced in:\n');
  console.error((err.stdout || '') + (err.stderr || ''));
}

/* ---------- 2. every challenge must be provably solvable ---------- */

const challenges = (mod.lessons || []).filter((l) => l.type === 'challenge' && !l.comingSoon);
for (const lesson of challenges) {
  const steps = solutions[lesson.id];
  if (!Array.isArray(steps) || !steps.length) {
    fail(`${lesson.id}: no "solutions" entry — add the commands that solve this challenge`);
    continue;
  }
  const e = new GitEngine();
  e.applySetup(lesson.exercise.setup || []);
  const transcript = [];
  for (const cmd of steps) {
    const r = e.run(cmd);
    transcript.push({ cmd, error: !!r.error, output: r.output });
  }
  const results = runChecks(e, lesson.exercise.expect);
  if (allPassed(results)) {
    const errored = transcript.filter((t) => t.error);
    if (errored.length) {
      // Not fatal — a lesson may deliberately walk through a rejected push —
      // but an author almost never means to leave a typo'd command in.
      console.log(`  note: ${lesson.id} solution includes ${errored.length} command(s) git rejected: ` +
        errored.map((t) => JSON.stringify(t.cmd)).join(', '));
    }
    pass(`${lesson.id}: solvable in ${steps.length} commands`);
  } else {
    fail(`${lesson.id}: the recorded solution does NOT satisfy the checks`);
    for (const r of results) {
      console.error(`    ${r.passed ? 'ok  ' : 'MISS'} ${r.label}`);
    }
    console.error('    transcript:');
    for (const t of transcript) {
      console.error(`      $ ${t.cmd}`);
      if (t.output) console.error(t.output.split('\n').map((l) => '        ' + l).join('\n'));
    }
  }
}

/* ---------- 3. guided walkthroughs: replay and optionally show ---------- */

const guided = (mod.lessons || []).filter((l) => l.type === 'guided' && !l.comingSoon);
for (const lesson of guided) {
  const steps = lesson.exercise.steps || [];
  const e = new GitEngine();
  e.applySetup(lesson.exercise.setup || []);
  let i = 0, guard = 0;
  const transcript = [];
  let stuck = null;
  while (i < steps.length && guard++ <= steps.length) {
    const at = i;
    for (const line of String(steps[at].cmd || '').split('\n').map((s) => s.trim()).filter(Boolean)) {
      const r = e.run(line);
      transcript.push({ step: at + 1, cmd: line, error: !!r.error, output: r.output });
      i = advanceSteps(e, steps, i);
    }
    if (i === at) { stuck = at; break; }
  }
  if (stuck != null) {
    fail(`${lesson.id}: step ${stuck + 1} is not satisfied by its own cmd (${JSON.stringify(steps[stuck].cmd)})`);
    for (const r of runChecks(e, steps[stuck].expect)) {
      console.error(`    ${r.passed ? 'ok  ' : 'MISS'} ${r.label}`);
    }
  } else if (i === steps.length) {
    pass(`${lesson.id}: walkthrough completes in ${steps.length} steps`);
  } else {
    fail(`${lesson.id}: walkthrough stalled at step ${i + 1} of ${steps.length}`);
  }
  const errored = transcript.filter((t) => t.error);
  if (errored.length) {
    console.log(`  note: ${lesson.id} walkthrough hits ${errored.length} git error(s): ` +
      errored.map((t) => `step ${t.step} ${JSON.stringify(t.cmd)}`).join(', '));
  }
  if (verbose) {
    console.log(`\n--- ${lesson.id} transcript ---`);
    for (const t of transcript) {
      console.log(`$ ${t.cmd}`);
      if (t.output) console.log(t.output.split('\n').map((l) => '  ' + l).join('\n'));
    }
    console.log('--- end ---\n');
  }
}

/* ---------- report ---------- */

console.log();
if (problems) {
  console.error(`${mod.id}: ${problems} problem(s) — NOT ready to merge`);
  process.exit(1);
}
console.log(`${mod.id}: ready to merge (${(mod.lessons || []).length} lessons, ${challenges.length} challenge(s) proven solvable)`);
