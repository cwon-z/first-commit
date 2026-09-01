/* Render content/course.json as readable Markdown.
 *
 *   node tools/course-to-md.mjs                 # whole course to stdout
 *   node tools/course-to-md.mjs m5 m6           # only those modules
 *   node tools/course-to-md.mjs > course.md
 *
 * For proof-reading prose and reviewing the course as a learner meets it,
 * rather than squinting at 300KB of JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const course = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'course.json'), 'utf8'));
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const out = [];
const w = (s = '') => out.push(s);

function renderBlocks(blocks, indent = '') {
  for (const b of blocks || []) {
    if (b.h != null) w(`${indent}### ${b.h}\n`);
    else if (b.p != null) w(`${indent}${b.p}\n`);
    else if (b.list != null) { for (const i of b.list) w(`${indent}- ${i}`); w(''); }
    else if (b.code != null) w(`${indent}\`\`\`\n${b.code}\n${indent}\`\`\`\n`);
    else if (b.analogy != null) w(`${indent}> **analogy** — ${b.analogy}\n`);
    else if (b.tip != null) w(`${indent}> **tip** — ${b.tip}\n`);
    else if (b.warn != null) w(`${indent}> **careful** — ${b.warn}\n`);
    else if (b.graph != null) {
      const ops = (b.graph.ops || []).map((o) => o.op + (o.name ? `:${o.name}` : o.path ? `:${o.path}` : o.message ? `:"${o.message}"` : '')).join(' → ');
      w(`${indent}\`[GRAPH]\` ${ops}`);
      if (b.graph.caption) w(`${indent}   _${b.graph.caption}_`);
      w('');
    } else w(`${indent}\`[UNKNOWN BLOCK ${JSON.stringify(Object.keys(b))}]\`\n`);
  }
}

w(`# ${course.meta.brand} — ${course.meta.tagline}\n`);

for (const mod of course.modules) {
  if (only.length && !only.includes(mod.id)) continue;
  w(`\n---\n`);
  w(`## Module ${mod.number} — ${mod.title}  \`${mod.id}\` (${mod.status})\n`);
  w(`_${mod.summary}_\n`);

  for (const lesson of mod.lessons) {
    w(`\n### ${lesson.id} · [${lesson.type}] ${lesson.title}\n`);
    if (lesson.comingSoon) { w('_(coming soon — no content yet)_\n'); continue; }
    renderBlocks(lesson.body);

    const ex = lesson.exercise;
    if (!ex) continue;

    if (ex.setup && ex.setup.length) {
      w('**Starting state:**');
      for (const op of ex.setup) w(`- \`${op.op}\`` + Object.entries(op).filter(([k]) => k !== 'op')
        .map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join(''));
      w('');
    }
    if (ex.steps) {
      w('**Walkthrough:**\n');
      ex.steps.forEach((s, i) => {
        w(`${i + 1}. ${s.say}`);
        w(`   \`\`\`\n   ${String(s.cmd).split('\n').join('\n   ')}\n   \`\`\``);
        if (s.hint) w(`   _hint: ${s.hint}_`);
        w(`   _checks: ${(s.expect || []).map((c) => c.kind).join(', ')}_`);
        w('');
      });
    }
    if (ex.goal) {
      w(`**Mission:** ${ex.goal}\n`);
      if (ex.hints) { w('**Hints:**'); ex.hints.forEach((h, i) => w(`${i + 1}. ${h}`)); w(''); }
      w('**Checklist the learner sees:**');
      for (const c of ex.expect || []) w(`- [ ] ${c.label}  \`(${c.kind})\``);
      w('');
    }
  }

  if (mod.recap) {
    w(`\n### ${mod.id}-recap · [recap] Module recap\n`);
    renderBlocks(mod.recap.body);
  }
}

console.log(out.join('\n'));
