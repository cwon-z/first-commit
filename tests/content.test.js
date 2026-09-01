/* Validates content/course.json against what the engine and the UI can
 * actually render and check. This is the authoring safety net: a typo'd block
 * key, an unknown check kind, an exercise that is already solved at setup, or
 * a lesson id the router can't match all fail here instead of silently doing
 * nothing in the browser.
 *
 * Run:  node tests/content.test.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitEngine, SETUP_OPS } from '../engine/git-engine.js';
import { CHECKS, runChecks, allPassed, advanceSteps } from '../engine/validators.js';
import { BLOCK_KINDS } from '../ui/lesson.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Defaults to the shipped course, but takes a path so a candidate file can be
// validated before it is merged in:  node tests/content.test.js draft.json
const COURSE_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'content', 'course.json');
const course = JSON.parse(fs.readFileSync(COURSE_PATH, 'utf8'));
// Reference solutions, so "every challenge is actually solvable" is a standing
// guarantee rather than something only checked while a module was being drafted.
const SOLUTIONS = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'tests', 'fixtures-solutions.json'), 'utf8')).solutions;

let passed = 0, failed = 0;
const failures = [];

function ok(cond, name) {
  if (cond) passed++;
  else { failed++; failures.push(name); }
}

const LESSON_TYPES = ['concept', 'guided', 'challenge'];
const MODULE_STATUSES = ['ready', 'coming-soon'];
/** The router only matches these characters — see `route()` in ui/app.js. */
const ROUTABLE_ID = /^[\w-]+$/;

/* ------------------------------- meta ---------------------------------- */
{
  const m = course.meta || {};
  ok(typeof m.brand === 'string' && m.brand.length > 0, 'meta.brand is a non-empty string');
  ok(typeof m.tagline === 'string' && m.tagline.length > 0, 'meta.tagline is a non-empty string');
  ok(typeof m.version === 'string', 'meta.version is a string');
  ok(typeof m.youtubeVideoId === 'string', 'meta.youtubeVideoId is a string (empty = no video yet)');
  if (m.youtubeVideoId) {
    ok(/^[\w-]{6,20}$/.test(m.youtubeVideoId), 'meta.youtubeVideoId looks like a YouTube id');
  }
}

/* ------------------------------ modules -------------------------------- */
ok(Array.isArray(course.modules) && course.modules.length > 0, 'course.modules is a non-empty array');

const seenModuleIds = new Set();
const seenLessonIds = new Set();

course.modules.forEach((mod, i) => {
  const where = `module ${mod.id || `#${i}`}`;

  ok(typeof mod.id === 'string' && ROUTABLE_ID.test(mod.id), `${where}: id is routable`);
  ok(!seenModuleIds.has(mod.id), `${where}: id is unique`);
  seenModuleIds.add(mod.id);

  ok(mod.number === i + 1, `${where}: number is ${i + 1} (modules are in order)`);
  ok(typeof mod.title === 'string' && mod.title.length > 0, `${where}: has a title`);
  // The landing page renders this as the card blurb.
  ok(typeof mod.summary === 'string' && mod.summary.length > 0, `${where}: has a summary`);
  ok(MODULE_STATUSES.includes(mod.status), `${where}: status is one of ${MODULE_STATUSES.join('/')}`);
  ok(Array.isArray(mod.lessons) && mod.lessons.length > 0, `${where}: has lessons`);

  const ready = mod.status === 'ready';
  if (ready) {
    ok(mod.recap && Array.isArray(mod.recap.body) && mod.recap.body.length > 0,
      `${where}: a ready module has a recap with a body`);
    // flatten() in app.js synthesises this id — it must not collide.
    ok(!seenLessonIds.has(`${mod.id}-recap`), `${where}: generated recap id is unique`);
    seenLessonIds.add(`${mod.id}-recap`);
    if (mod.recap && Array.isArray(mod.recap.body)) checkBody(mod.recap.body, `${where} recap`);
  }

  for (const lesson of mod.lessons || []) {
    checkLesson(lesson, mod, ready);
  }
});

/* ------------------------------ lessons -------------------------------- */

function checkLesson(lesson, mod, moduleReady) {
  const where = `lesson ${lesson.id}`;

  ok(typeof lesson.id === 'string' && ROUTABLE_ID.test(lesson.id), `${where}: id is routable`);
  ok(!seenLessonIds.has(lesson.id), `${where}: id is unique across the whole course`);
  ok(lesson.id !== 'playground', `${where}: id does not collide with the playground route`);
  seenLessonIds.add(lesson.id);

  ok(typeof lesson.title === 'string' && lesson.title.length > 0, `${where}: has a title`);
  ok(LESSON_TYPES.includes(lesson.type), `${where}: type is one of ${LESSON_TYPES.join('/')}`);

  // A module's status and its lessons' comingSoon flags must agree, otherwise
  // the sidebar badge and the lesson body tell the learner different stories.
  if (moduleReady) {
    ok(!lesson.comingSoon, `${where}: a lesson in a ready module is not comingSoon`);
  } else {
    ok(lesson.comingSoon === true, `${where}: a lesson in a coming-soon module is flagged comingSoon`);
  }

  if (lesson.comingSoon) return; // stubs carry no body or exercise yet

  ok(Array.isArray(lesson.body), `${where}: body is an array`);
  checkBody(lesson.body || [], where);

  if (lesson.type === 'concept') {
    ok((lesson.body || []).length > 0, `${where}: a concept lesson has body content`);
    ok(lesson.exercise == null, `${where}: a concept lesson has no exercise`);
    return;
  }

  const ex = lesson.exercise;
  ok(ex != null, `${where}: a ${lesson.type} lesson has an exercise`);
  if (!ex) return;

  ok(Array.isArray(ex.setup), `${where}: exercise.setup is an array`);
  for (const op of ex.setup || []) {
    ok(SETUP_OPS.includes(op.op), `${where}: setup op "${op.op}" is one the engine implements`);
  }

  if (lesson.type === 'guided') checkGuided(lesson, ex, where);
  else if (lesson.type === 'challenge') checkChallenge(lesson, ex, where);
}

function checkBody(body, where) {
  body.forEach((block, i) => {
    const keys = Object.keys(block);
    const known = keys.filter((k) => BLOCK_KINDS.includes(k));
    ok(known.length === 1,
      `${where}: body block #${i} has exactly one known kind (got ${JSON.stringify(keys)})`);
    if (block.list != null) {
      ok(Array.isArray(block.list) && block.list.length > 0, `${where}: body block #${i} list is non-empty`);
    }
    if (block.graph != null) {
      ok(Array.isArray(block.graph.ops), `${where}: body block #${i} graph has an ops array`);
      // Diagrams are drawn by replaying these ops, so they must be real ops.
      const e = new GitEngine();
      e.applySetup(block.graph.ops || []);
      ok(e.setupWarnings.length === 0,
        `${where}: body block #${i} graph ops are all implemented (${e.setupWarnings.join('; ')})`);
    }
  });
}

/** Every check must name a kind the validator catalog implements, and carry a
 *  human-readable label — the label is what the learner sees in the checklist. */
function checkExpectations(list, where, { allowCommandRan }) {
  ok(Array.isArray(list) && list.length > 0, `${where}: has at least one check`);
  for (const check of list || []) {
    ok(typeof CHECKS[check.kind] === 'function', `${where}: check kind "${check.kind}" exists`);
    ok(typeof check.label === 'string' && check.label.length > 0,
      `${where}: check "${check.kind}" has a label`);
    if (!allowCommandRan) {
      // Documented rule in validators.js: challenges are state-based only.
      ok(check.kind !== 'commandRan', `${where}: a challenge does not use commandRan`);
    }
  }
}

function checkGuided(lesson, ex, where) {
  ok(Array.isArray(ex.steps) && ex.steps.length > 0, `${where}: has guided steps`);
  (ex.steps || []).forEach((step, i) => {
    ok(typeof step.say === 'string' && step.say.length > 0, `${where}: step ${i + 1} has instructions`);
    // A guided step shows the learner exactly what to type; that contract is
    // what makes the walkthrough replayable below.
    ok(typeof step.cmd === 'string' && step.cmd.trim().length > 0,
      `${where}: step ${i + 1} shows the command to type`);
    checkExpectations(step.expect, `${where} step ${i + 1}`, { allowCommandRan: true });
  });

  // The setup must not already satisfy step 1, or the learner opens the lesson
  // with a step mysteriously pre-ticked.
  const e = new GitEngine();
  e.applySetup(ex.setup || []);
  ok(e.setupWarnings.length === 0, `${where}: setup runs cleanly (${e.setupWarnings.join('; ')})`);
  const first = (ex.steps || [])[0];
  if (first && Array.isArray(first.expect)) {
    ok(!allPassed(runChecks(e, first.expect)), `${where}: step 1 is not already satisfied by the setup`);
  }

  checkWalkthroughCompletes(ex, where);
}

/**
 * Replay a guided lesson by typing exactly the commands it displays, driving
 * the same `advanceSteps` cascade the browser uses. If a step's own `cmd`
 * doesn't satisfy that step's checks, the learner would be stuck staring at an
 * instruction that doesn't work — so that fails here instead.
 */
function checkWalkthroughCompletes(ex, where) {
  const steps = ex.steps || [];
  if (!steps.length || !steps.every((s) => typeof s.cmd === 'string' && s.cmd.trim())) return;

  const e = new GitEngine();
  e.applySetup(ex.setup || []);
  let idx = 0;
  let guard = 0;
  while (idx < steps.length && guard++ <= steps.length) {
    const at = idx;
    const lines = steps[at].cmd.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      e.run(line);
      idx = advanceSteps(e, steps, idx);
    }
    if (idx === at) {
      ok(false, `${where}: step ${at + 1} is satisfied by running its own cmd (${JSON.stringify(steps[at].cmd)})`);
      return;
    }
    passed++; // the step advanced
  }
  ok(idx === steps.length, `${where}: the whole walkthrough completes by following it`);
}

function checkChallenge(lesson, ex, where) {
  ok(typeof ex.goal === 'string' && ex.goal.length > 0, `${where}: has a goal`);
  ok(Array.isArray(ex.hints), `${where}: hints is an array`);
  for (const h of ex.hints || []) {
    ok(typeof h === 'string' && h.length > 0, `${where}: every hint is a non-empty string`);
  }
  checkExpectations(ex.expect, where, { allowCommandRan: false });

  const e = new GitEngine();
  e.applySetup(ex.setup || []);
  ok(e.setupWarnings.length === 0, `${where}: setup runs cleanly (${e.setupWarnings.join('; ')})`);
  // A challenge that passes before the learner types anything is broken.
  if (Array.isArray(ex.expect) && ex.expect.length) {
    ok(!allPassed(runChecks(e, ex.expect)), `${where}: is not already solved by its own setup`);
  }

  checkChallengeSolvable(lesson, ex, where);
}

/**
 * Replay the reference solution and require the checks to go green. Without
 * this a challenge could be stated in a way no sequence of commands satisfies —
 * the "not already solved" check above only proves it isn't trivially passed.
 */
function checkChallengeSolvable(lesson, ex, where) {
  const steps = SOLUTIONS[lesson.id];
  if (!Array.isArray(steps) || !steps.length) {
    ok(false, `${where}: no reference solution in tests/fixtures-solutions.json`);
    return;
  }
  const e = new GitEngine();
  e.applySetup(ex.setup || []);
  for (const cmd of steps) e.run(cmd);
  const results = runChecks(e, ex.expect || []);
  const missed = results.filter((r) => !r.passed).map((r) => r.label);
  ok(missed.length === 0,
    `${where}: the reference solution satisfies every check` +
    (missed.length ? ` (missed: ${missed.join(' | ')})` : ''));
}

/* -------------------- the solutions fixture stays in sync ---------------- */
{
  const challengeIds = course.modules
    .flatMap((m) => m.lessons)
    .filter((l) => l.type === 'challenge' && !l.comingSoon)
    .map((l) => l.id);
  for (const id of challengeIds) {
    ok(Array.isArray(SOLUTIONS[id]) && SOLUTIONS[id].length > 0,
      `fixtures-solutions.json has a solution for ${id}`);
  }
  for (const id of Object.keys(SOLUTIONS)) {
    ok(challengeIds.includes(id), `fixtures-solutions.json entry "${id}" matches a real challenge`);
  }
}

/* ---------------- landing page reads these fields directly --------------- */
{
  const landing = fs.readFileSync(path.join(ROOT, 'ui', 'landing.js'), 'utf8');
  ok(landing.includes('mod.summary'), 'landing.js renders module summaries from course.json');
  ok(landing.includes('youtubeVideoId'), 'landing.js reads meta.youtubeVideoId');
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(index.includes('id="module-grid"'), 'index.html has the curriculum mount point');
  ok(!/<li class="mod/.test(index), 'index.html has no hand-copied module list to drift');
}

/* ------------------------------- report --------------------------------- */
console.log(`\n${path.relative(ROOT, COURSE_PATH) || 'content/course.json'}: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
