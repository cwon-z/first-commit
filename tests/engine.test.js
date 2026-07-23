/* Unit tests for the simulated git engine + validators.
 * Run:  node tests/engine.test.js
 */
import { GitEngine } from '../engine/git-engine.js';
import { runChecks, allPassed } from '../engine/validators.js';

let passed = 0, failed = 0;
const failures = [];

function ok(cond, name, extra) {
  if (cond) { passed++; }
  else { failed++; failures.push(name + (extra ? `\n    ${extra}` : '')); }
}

function includes(haystack, needle, name) {
  ok(haystack.includes(needle), name, `expected output to include: ${JSON.stringify(needle)}\n    got: ${JSON.stringify(haystack)}`);
}

/* ---- 1. init / untracked / add / commit ---- */
{
  const e = new GitEngine();
  let r = e.run('git status');
  includes(r.output, 'fatal: not a git repository', 'status before init errors');
  ok(r.error, 'status before init is an error');

  r = e.run('git init');
  includes(r.output, 'Initialized empty Git repository', 'init output');

  e.run('echo "hello world" > hello.txt');
  ok(e.fs.get('hello.txt') === 'hello world\n', 'echo > writes file');

  r = e.run('git status');
  includes(r.output, 'No commits yet', 'status shows no commits yet');
  includes(r.output, 'Untracked files:', 'status shows untracked section');
  includes(r.output, 'hello.txt', 'status lists untracked file');
  includes(r.output, 'nothing added to commit but untracked files present', 'status untracked footer');

  r = e.run('git add hello.txt');
  ok(!r.error, 'git add succeeds');
  r = e.run('git status');
  includes(r.output, 'Changes to be committed:', 'status shows staged section');
  includes(r.output, 'new file:   hello.txt', 'status shows new file staged');

  r = e.run('git commit -m "First commit"');
  includes(r.output, '(root-commit)', 'first commit is root-commit');
  includes(r.output, 'First commit', 'commit message in output');
  includes(r.output, '1 file changed, 1 insertion(+)', 'commit stat line');
  includes(r.output, 'create mode 100644 hello.txt', 'create mode line');

  r = e.run('git status');
  includes(r.output, 'nothing to commit, working tree clean', 'clean after commit');

  r = e.run('git log');
  includes(r.output, 'HEAD -> main', 'log decoration');
  includes(r.output, 'Author: Learner', 'log author');
  includes(r.output, 'First commit', 'log message');

  r = e.run('git log --oneline');
  ok(/^[0-9a-f]{7} \(HEAD -> main\) First commit$/.test(r.output), 'oneline format', r.output);
}

/* ---- 2. modify / diff / diff --staged ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'a.txt', content: 'line one\nline two' },
    { op: 'add' }, { op: 'commit', message: 'add a' },
  ]);
  e.run('echo "line three" >> a.txt');
  let r = e.run('git diff');
  includes(r.output, 'diff --git a/a.txt b/a.txt', 'diff header');
  includes(r.output, '+line three', 'diff shows added line');
  includes(r.output, '@@', 'diff has hunk header');

  e.run('git add a.txt');
  r = e.run('git diff');
  ok(r.output === '', 'diff empty after staging');
  r = e.run('git diff --staged');
  includes(r.output, '+line three', 'diff --staged shows staged change');

  // unstage via restore --staged
  e.run('git restore --staged a.txt');
  r = e.run('git diff --staged');
  ok(r.output === '', 'restore --staged unstages');
  r = e.run('git diff');
  includes(r.output, '+line three', 'change back in unstaged diff');
}

/* ---- 3. branch / switch / fast-forward merge ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'app.js', content: 'console.log(1)' },
    { op: 'add' }, { op: 'commit', message: 'base' },
  ]);
  let r = e.run('git switch -c feature');
  includes(r.output, "Switched to a new branch 'feature'", 'switch -c output');
  e.run('echo "more" > feature.txt');
  e.run('git add feature.txt');
  e.run('git commit -m "feature work"');
  r = e.run('git branch');
  includes(r.output, '* feature', 'branch list marks current');
  includes(r.output, '  main', 'branch list shows main');

  r = e.run('git switch main');
  includes(r.output, "Switched to branch 'main'", 'switch back');
  ok(!e.fs.has('feature.txt'), 'feature file absent on main');

  r = e.run('git merge feature');
  includes(r.output, 'Fast-forward', 'ff merge output');
  includes(r.output, 'Updating', 'ff merge updating line');
  ok(e.fs.has('feature.txt'), 'ff merge brings file');
  ok(e.branches.get('main') === e.branches.get('feature'), 'ff moves main to feature tip');

  r = e.run('git merge feature');
  includes(r.output, 'Already up to date.', 'merge already up to date');

  r = e.run('git branch -d feature');
  includes(r.output, 'Deleted branch feature', 'branch delete after merge');
}

/* ---- 4. divergent merge (clean) creates merge commit ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'base.txt', content: 'base' },
    { op: 'add' }, { op: 'commit', message: 'base' },
    { op: 'switchCreate', name: 'feature' },
    { op: 'write', path: 'f.txt', content: 'feature' },
    { op: 'add' }, { op: 'commit', message: 'feature commit' },
    { op: 'switch', name: 'main' },
    { op: 'write', path: 'm.txt', content: 'main' },
    { op: 'add' }, { op: 'commit', message: 'main commit' },
  ]);
  const r = e.run('git merge feature');
  includes(r.output, "Merge made by the 'ort' strategy.", 'ort merge output');
  const tip = e.commits.get(e.branches.get('main'));
  ok(tip.parents.length === 2, 'merge commit has two parents');
  ok(e.fs.has('f.txt') && e.fs.has('m.txt'), 'merge combines both files');
}

/* ---- 5. merge conflict → resolve → commit ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'greeting.txt', content: 'hello' },
    { op: 'add' }, { op: 'commit', message: 'base' },
    { op: 'switchCreate', name: 'spanish' },
    { op: 'write', path: 'greeting.txt', content: 'hola' },
    { op: 'add' }, { op: 'commit', message: 'spanish greeting' },
    { op: 'switch', name: 'main' },
    { op: 'write', path: 'greeting.txt', content: 'howdy' },
    { op: 'add' }, { op: 'commit', message: 'texan greeting' },
  ]);
  let r = e.run('git merge spanish');
  ok(r.error, 'conflicted merge errors');
  includes(r.output, 'CONFLICT (content): Merge conflict in greeting.txt', 'conflict message');
  includes(r.output, 'Automatic merge failed', 'conflict footer');
  includes(e.fs.get('greeting.txt'), '<<<<<<< HEAD', 'conflict markers written');
  includes(e.fs.get('greeting.txt'), '>>>>>>> spanish', 'their marker written');

  r = e.run('git status');
  includes(r.output, 'You have unmerged paths.', 'status during conflict');
  includes(r.output, 'both modified:   greeting.txt', 'unmerged path listed');

  r = e.run('git commit -m "nope"');
  ok(r.error, 'commit blocked during conflict');
  includes(r.output, 'unmerged files', 'commit blocked message');

  e.run('echo "howdy y hola" > greeting.txt');
  e.run('git add greeting.txt');
  r = e.run('git status');
  includes(r.output, 'All conflicts fixed but you are still in a merge.', 'status after resolution');

  r = e.run('git commit');
  includes(r.output, "Merge branch 'spanish'", 'merge commit default message');
  const tip = e.commits.get(e.branches.get('main'));
  ok(tip.parents.length === 2, 'resolved merge commit has 2 parents');
  ok(!e.mergeState, 'merge state cleared');
}

/* ---- 6. merge --abort restores state ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'x.txt', content: 'base' },
    { op: 'add' }, { op: 'commit', message: 'base' },
    { op: 'switchCreate', name: 'b' },
    { op: 'write', path: 'x.txt', content: 'theirs' },
    { op: 'add' }, { op: 'commit', message: 'theirs' },
    { op: 'switch', name: 'main' },
    { op: 'write', path: 'x.txt', content: 'ours' },
    { op: 'add' }, { op: 'commit', message: 'ours' },
  ]);
  e.run('git merge b');
  e.run('git merge --abort');
  ok(e.fs.get('x.txt') === 'ours\n', 'abort restores working file');
  ok(!e.mergeState, 'abort clears merge state');
}

/* ---- 7. checkout blocked by local changes ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'file.txt', content: 'v1' },
    { op: 'add' }, { op: 'commit', message: 'v1' },
    { op: 'switchCreate', name: 'other' },
    { op: 'write', path: 'file.txt', content: 'v2' },
    { op: 'add' }, { op: 'commit', message: 'v2' },
    { op: 'switch', name: 'main' },
  ]);
  e.run('echo "dirty" > file.txt');
  const r = e.run('git switch other');
  ok(r.error, 'dirty switch blocked');
  includes(r.output, 'Your local changes to the following files would be overwritten', 'block message');
  includes(r.output, 'Aborting', 'abort message');
  ok(e.currentBranch() === 'main', 'still on main after blocked switch');
}

/* ---- 8. detached HEAD ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'a.txt', content: '1' },
    { op: 'add' }, { op: 'commit', message: 'one' },
    { op: 'write', path: 'a.txt', content: '2' },
    { op: 'add' }, { op: 'commit', message: 'two' },
  ]);
  const firstId = e.resolveRef('HEAD~1');
  const r = e.run(`git checkout ${firstId.slice(0, 7)}`);
  includes(r.output, "detached HEAD", 'detached head note');
  includes(r.output, 'HEAD is now at', 'detached head position');
  ok(e.HEAD.type === 'commit', 'HEAD is detached');
  ok(e.fs.get('a.txt') === '1\n', 'working dir matches old commit');
  const st = e.run('git status');
  includes(st.output, 'HEAD detached at', 'status shows detached');
  // switch requires --detach
  const e2 = new GitEngine();
  e2.applySetup([
    { op: 'init' }, { op: 'write', path: 'a.txt', content: '1' },
    { op: 'add' }, { op: 'commit', message: 'one' },
    { op: 'write', path: 'a.txt', content: '2' },
    { op: 'add' }, { op: 'commit', message: 'two' },
  ]);
  const sha = e2.resolveRef('HEAD~1');
  const r2 = e2.run(`git switch ${sha.slice(0, 7)}`);
  ok(r2.error, 'switch to sha without --detach errors');
  includes(r2.output, '--detach', 'switch suggests --detach');
}

/* ---- 9. reset soft/mixed/hard ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'a.txt', content: 'one' },
    { op: 'add' }, { op: 'commit', message: 'c1' },
    { op: 'write', path: 'a.txt', content: 'two' },
    { op: 'add' }, { op: 'commit', message: 'c2' },
  ]);
  const c1 = e.resolveRef('HEAD~1');

  // soft: index still has 'two'
  e.run('git reset --soft HEAD~1');
  ok(e.headCommitId() === c1, 'soft reset moves branch');
  ok(e.index.get('a.txt') === 'two\n', 'soft reset keeps index');
  const st = e.run('git status');
  includes(st.output, 'modified:   a.txt', 'soft reset shows staged change');

  // back up and hard reset
  const e2 = new GitEngine();
  e2.applySetup([
    { op: 'init' },
    { op: 'write', path: 'a.txt', content: 'one' },
    { op: 'add' }, { op: 'commit', message: 'c1' },
    { op: 'write', path: 'a.txt', content: 'two' },
    { op: 'add' }, { op: 'commit', message: 'c2' },
  ]);
  const r = e2.run('git reset --hard HEAD~1');
  includes(r.output, 'HEAD is now at', 'hard reset output');
  includes(r.output, 'c1', 'hard reset target message');
  ok(e2.fs.get('a.txt') === 'one\n', 'hard reset restores working dir');
  const st2 = e2.run('git status');
  includes(st2.output, 'nothing to commit, working tree clean', 'clean after hard reset');
}

/* ---- 10. revert ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'a.txt', content: 'good' },
    { op: 'add' }, { op: 'commit', message: 'good change' },
    { op: 'write', path: 'a.txt', content: 'bad' },
    { op: 'add' }, { op: 'commit', message: 'bad change' },
  ]);
  const r = e.run('git revert HEAD');
  includes(r.output, 'Revert "bad change"', 'revert message');
  ok(e.fs.get('a.txt') === 'good\n', 'revert restores content');
  const n = e.ancestorsOf(e.headCommitId()).size;
  ok(n === 3, 'revert adds a commit (history preserved)');
}

/* ---- 11. remotes: push, reject, pull ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'readme.md', content: 'hi' },
    { op: 'add' }, { op: 'commit', message: 'initial' },
  ]);
  let r = e.run('git push');
  ok(r.error, 'push without remote errors');
  includes(r.output, 'No configured push destination', 'push no remote message');

  e.run('git remote add origin https://github.com/learner/project.git');
  r = e.run('git remote -v');
  includes(r.output, 'origin\thttps://github.com/learner/project.git (fetch)', 'remote -v');

  r = e.run('git push');
  ok(r.error, 'push without upstream errors');
  includes(r.output, 'has no upstream branch', 'upstream hint');

  r = e.run('git push -u origin main');
  includes(r.output, '* [new branch]      main -> main', 'push new branch');
  includes(r.output, "branch 'main' set up to track", 'upstream set message');

  r = e.run('git push');
  includes(r.output, 'Everything up-to-date', 'push up to date');

  // teammate pushes → our push is rejected → pull → push
  e.applySetup([{ op: 'remoteCommit', path: 'team.txt', content: 'from teammate', message: 'Teammate adds team.txt' }]);
  e.run('echo "local work" > local.txt');
  e.run('git add local.txt');
  e.run('git commit -m "local work"');
  r = e.run('git push');
  ok(r.error, 'non-ff push rejected');
  includes(r.output, '! [rejected]', 'rejected marker');
  includes(r.output, 'fetch first', 'fetch first hint');

  r = e.run('git pull');
  ok(!r.error, 'pull succeeds');
  ok(e.fs.has('team.txt'), 'pull brings teammate file');
  const tip = e.commits.get(e.branches.get('main'));
  ok(tip.parents.length === 2, 'pull created merge commit (divergent)');

  r = e.run('git push');
  ok(!r.error, 'push after pull succeeds');
  ok(e.remotes.origin.branches.main === e.branches.get('main'), 'remote tip updated');
}

/* ---- 12. pull fast-forward ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'readme.md', content: 'hi' },
    { op: 'add' }, { op: 'commit', message: 'initial' },
    { op: 'remote' },
    { op: 'remoteCommit', path: 'news.txt', content: 'breaking', message: 'Teammate news' },
  ]);
  const r = e.run('git pull');
  includes(r.output, 'Fast-forward', 'pull ff output');
  ok(e.fs.has('news.txt'), 'pull ff brings file');
}

/* ---- 13. rebase happy path ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'base.txt', content: 'base' },
    { op: 'add' }, { op: 'commit', message: 'base' },
    { op: 'switchCreate', name: 'feature' },
    { op: 'write', path: 'f.txt', content: 'f' },
    { op: 'add' }, { op: 'commit', message: 'feature 1' },
    { op: 'switch', name: 'main' },
    { op: 'write', path: 'm.txt', content: 'm' },
    { op: 'add' }, { op: 'commit', message: 'main 1' },
    { op: 'switch', name: 'feature' },
  ]);
  const r = e.run('git rebase main');
  includes(r.output, 'Successfully rebased and updated refs/heads/feature.', 'rebase output');
  ok(e.fs.has('m.txt') && e.fs.has('f.txt'), 'rebase result has both files');
  const tip = e.commits.get(e.branches.get('feature'));
  ok(tip.message === 'feature 1', 'replayed commit message');
  ok(e.isAncestor(e.branches.get('main'), e.branches.get('feature')), 'feature now on top of main');
}

/* ---- 14. reflog ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'a.txt', content: '1' },
    { op: 'add' }, { op: 'commit', message: 'one' },
    { op: 'switchCreate', name: 'dev' },
  ]);
  const r = e.run('git reflog');
  includes(r.output, 'HEAD@{0}: checkout: moving from main to dev', 'reflog checkout entry');
  includes(r.output, 'commit (initial): one', 'reflog commit entry');
}

/* ---- 15. .gitignore ---- */
{
  const e = new GitEngine();
  e.applySetup([{ op: 'init' }]);
  e.run('echo "*.log" > .gitignore');
  e.run('echo "secret" > debug.log');
  e.run('echo "code" > app.js');
  const r = e.run('git status');
  includes(r.output, 'app.js', 'status shows non-ignored file');
  includes(r.output, '.gitignore', 'status shows .gitignore itself');
  ok(!r.output.includes('debug.log'), 'ignored file hidden from status');
  e.run('git add .');
  ok(!e.index.has('debug.log'), 'git add . skips ignored file');
  ok(e.index.has('app.js'), 'git add . stages other files');
}

/* ---- 16. validators ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'journal.txt', content: 'day one' },
  ]);
  let res = runChecks(e, [
    { kind: 'repoInitialized', label: 'repo exists' },
    { kind: 'fileCommitted', path: 'journal.txt', label: 'journal committed' },
  ]);
  ok(res[0].passed === true, 'validator repoInitialized passes');
  ok(res[1].passed === false, 'validator fileCommitted fails before commit');
  ok(allPassed(res) === false, 'allPassed false');

  e.run('git add journal.txt');
  res = runChecks(e, [{ kind: 'fileStaged', path: 'journal.txt' }]);
  ok(res[0].passed === true, 'validator fileStaged passes');

  e.run('git commit -m "Start my journal"');
  res = runChecks(e, [
    { kind: 'fileCommitted', path: 'journal.txt', contains: 'day one' },
    { kind: 'cleanWorkingTree' },
    { kind: 'headOnBranch', name: 'main' },
    { kind: 'commitCount', min: 1 },
    { kind: 'lastCommitMessage', minLength: 3 },
  ]);
  ok(allPassed(res) === true, 'full challenge validation passes');

  // commitTouched exact
  e.run('echo "x" > a.txt');
  e.run('echo "y" > b.txt');
  e.run('git add a.txt');
  e.run('git commit -m "only a"');
  res = runChecks(e, [{ kind: 'commitTouched', ref: 'HEAD', paths: ['a.txt'], exact: true }]);
  ok(res[0].passed === true, 'commitTouched exact passes');
  res = runChecks(e, [{ kind: 'commitTouched', ref: 'HEAD', paths: ['b.txt'] }]);
  ok(res[0].passed === false, 'commitTouched wrong path fails');

  // fileChanged (vs setup snapshot)
  const e2 = new GitEngine();
  e2.applySetup([{ op: 'write', path: 'story.txt', content: 'original' }]);
  res = runChecks(e2, [{ kind: 'fileChanged', path: 'story.txt' }]);
  ok(res[0].passed === false, 'fileChanged false before edit');
  e2.run('echo "rewritten" > story.txt');
  res = runChecks(e2, [{ kind: 'fileChanged', path: 'story.txt' }]);
  ok(res[0].passed === true, 'fileChanged true after edit');

  // commandRan is semantic
  e2.run('ls');
  res = runChecks(e2, [{ kind: 'commandRan', command: 'ls' }]);
  ok(res[0].passed === true, 'commandRan ls passes');
  e2.run('cat story.txt');
  res = runChecks(e2, [{ kind: 'commandRan', command: 'ls' }]);
  ok(res[0].passed === false, 'commandRan only matches most recent');
}

/* ---- 17. error messages ---- */
{
  const e = new GitEngine();
  e.applySetup([{ op: 'init' }]);
  let r = e.run('git blame');
  includes(r.output, "git: 'blame' is not a git command.", 'unknown subcommand');
  r = e.run('git add nope.txt');
  includes(r.output, "fatal: pathspec 'nope.txt' did not match any files", 'add missing file');
  r = e.run('git log');
  includes(r.output, "does not have any commits yet", 'log with no commits');
  r = e.run('git commit -m "empty"');
  ok(r.error, 'commit with nothing staged errors');
  r = e.run('git checkout nope');
  includes(r.output, "did not match any file(s) known to git", 'checkout unknown ref');
  r = e.run('nonsense');
  includes(r.output, 'nonsense: command not found', 'unknown shell command');
}

/* ---- 18. graph + file state adapters ---- */
{
  const e = new GitEngine();
  e.applySetup([
    { op: 'init' },
    { op: 'write', path: 'a.txt', content: '1' },
    { op: 'add' }, { op: 'commit', message: 'one' },
    { op: 'switchCreate', name: 'dev' },
    { op: 'write', path: 'b.txt', content: '2' },
    { op: 'add' }, { op: 'commit', message: 'two' },
  ]);
  const g = e.getGraph();
  ok(g.commits.length === 2, 'graph has 2 commits');
  ok(g.branches.length === 2, 'graph has 2 branches');
  ok(g.head.ref === 'dev', 'graph head ref');
  ok(g.commits[1].parents[0] === g.commits[0].id, 'graph parent link');
  ok(g.commits[1].branchHint === 'dev', 'branchHint recorded');

  e.run('echo "3" > c.txt');
  e.run('echo "edit" >> a.txt');
  e.run('git add c.txt');
  const fsState = e.getFileState();
  const find = (list, p) => list.find((f) => f.path === p);
  ok(find(fsState.working, 'c.txt').state === 'clean', 'staged new file clean in working');
  ok(find(fsState.working, 'a.txt').state === 'modified', 'modified file flagged');
  ok(find(fsState.index, 'c.txt').state === 'added', 'index shows added');
  ok(find(fsState.repo, 'a.txt') != null, 'repo shows committed file');
}

/* ---- report ---- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
