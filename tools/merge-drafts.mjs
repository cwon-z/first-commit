/* Merge drafted modules into the shipped course.
 *
 *   node tools/merge-drafts.mjs            # dry run: report only
 *   node tools/merge-drafts.mjs --write    # actually update content/course.json
 *
 * Reads every drafts/module-*.json, checks each one against the harness rules,
 * splices them into content/course.json by module id, and refuses to write
 * unless the whole course still validates. Modules that already ship are
 * compared before and after so a merge can never silently disturb them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const write = process.argv.includes('--write');
const COURSE = path.join(ROOT, 'content', 'course.json');

const before = JSON.parse(fs.readFileSync(COURSE, 'utf8'));
const course = JSON.parse(JSON.stringify(before));

const draftDir = path.join(ROOT, 'drafts');
const drafts = fs.existsSync(draftDir)
  ? fs.readdirSync(draftDir).filter((f) => /^module-\d+\.json$/.test(f)).sort(
      (a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))
  : [];

if (!drafts.length) {
  console.error('no drafts/module-*.json files found');
  process.exit(1);
}

const untouched = new Set(course.modules.map((m) => m.id));
const merged = [];
let problems = 0;

for (const file of drafts) {
  const draft = JSON.parse(fs.readFileSync(path.join(draftDir, file), 'utf8'));
  const mod = draft.module;
  if (!mod || !mod.id) { console.error(`✗ ${file}: no module.id`); problems++; continue; }
  const idx = course.modules.findIndex((m) => m.id === mod.id);
  if (idx === -1) { console.error(`✗ ${file}: no module "${mod.id}" in the course`); problems++; continue; }

  if (mod.status !== 'ready') {
    console.error(`✗ ${file}: status is "${mod.status}", expected "ready"`);
    problems++;
  }
  const stillSoon = (mod.lessons || []).filter((l) => l.comingSoon);
  if (stillSoon.length) {
    console.error(`✗ ${file}: ${stillSoon.map((l) => l.id).join(', ')} still flagged comingSoon`);
    problems++;
  }
  // Lesson ids are the router's URLs and the progress store's keys — a draft
  // that renames one silently orphans anyone's saved progress.
  const wantIds = (before.modules[idx].lessons || []).map((l) => l.id).join(',');
  const gotIds = (mod.lessons || []).map((l) => l.id).join(',');
  if (wantIds !== gotIds) {
    console.error(`✗ ${file}: lesson ids changed — expected [${wantIds}], got [${gotIds}]`);
    problems++;
  }

  course.modules[idx] = mod;
  untouched.delete(mod.id);
  merged.push({ id: mod.id, file, lessons: (mod.lessons || []).length, challenges: Object.keys(draft.solutions || {}).length });
}

/* Modules nobody drafted must come through completely unchanged. */
for (const id of untouched) {
  const a = JSON.stringify(before.modules.find((m) => m.id === id));
  const b = JSON.stringify(course.modules.find((m) => m.id === id));
  if (a !== b) { console.error(`✗ module ${id} was modified but has no draft`); problems++; }
}

/* Validate the fully merged course before it is allowed anywhere near disk. */
const tmp = path.join(draftDir, '.candidates', 'course-merged.json');
fs.mkdirSync(path.dirname(tmp), { recursive: true });
fs.writeFileSync(tmp, JSON.stringify(course, null, 2));
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tests', 'content.test.js'), tmp], { cwd: ROOT, encoding: 'utf8' });
  console.log('✓ merged course passes the content test — ' + out.trim().split('\n').pop());
} catch (err) {
  problems++;
  console.error('✗ merged course FAILS the content test:\n' + (err.stdout || '') + (err.stderr || ''));
}

console.log();
for (const m of merged) console.log(`  ${m.id.padEnd(4)} ${String(m.lessons)} lessons  ${m.challenges} solved challenge(s)  ← ${m.file}`);
const ready = course.modules.filter((m) => m.status === 'ready').length;
console.log(`\n${ready}/${course.modules.length} modules ready`);

if (problems) {
  console.error(`\n${problems} problem(s) — refusing to write`);
  process.exit(1);
}
if (!write) {
  console.log('\ndry run OK — re-run with --write to update content/course.json');
  process.exit(0);
}

// course.json is CRLF like the rest of the repo.
fs.writeFileSync(COURSE, JSON.stringify(course, null, 2).replace(/\n/g, '\r\n') + '\r\n');
console.log(`\nwrote ${path.relative(ROOT, COURSE)}`);
