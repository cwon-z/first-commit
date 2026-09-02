/* Unit tests for the simulated git engine + validators.
 * Run:  node tests/engine.test.js
 */
import { GitEngine, SETUP_OPS } from '../engine/git-engine.js';
import { runChecks, allPassed, advanceSteps } from '../engine/validators.js';

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

/* ---- 13. reset --hard removes files that only existed in discarded commits ---- */
{
  const e = new GitEngine();
  e.run('git init');
  e.run('touch a.txt'); e.run('git add .'); e.run('git commit -m one');
  e.run('touch b.txt'); e.run('git add .'); e.run('git commit -m two');
  e.run('echo "mine" > scratch.txt');            // untracked — must survive
  e.run('git reset --hard HEAD~1');
  ok(!e.fs.has('b.txt'), 'reset --hard deletes a file from the discarded commit');
  ok(!e.index.has('b.txt'), 'reset --hard drops it from the index too');
  ok(e.fs.has('a.txt'), 'reset --hard keeps files the target commit has');
  ok(e.fs.has('scratch.txt'), 'reset --hard leaves untracked files alone');

  // --soft and --mixed must NOT touch the working tree
  const s = new GitEngine();
  s.run('git init');
  s.run('touch a.txt'); s.run('git add .'); s.run('git commit -m one');
  s.run('touch b.txt'); s.run('git add .'); s.run('git commit -m two');
  s.run('git reset --soft HEAD~1');
  ok(s.fs.has('b.txt'), 'reset --soft keeps the working file');
  ok(s.index.has('b.txt'), 'reset --soft keeps it staged');
  s.run('git reset --mixed HEAD');
  ok(s.fs.has('b.txt'), 'reset --mixed keeps the working file');
}

/* ---- 14. push/fetch/pull honour the remote name; -u controls upstream ---- */
{
  const e = new GitEngine();
  e.run('git init'); e.run('touch a.txt'); e.run('git add .'); e.run('git commit -m one');
  e.run('git remote add origin https://github.com/me/p.git');

  let r = e.run('git push origin main');
  ok(!r.error, 'git push origin main succeeds');
  ok(!e.upstreams.has('main'), 'push without -u does not set an upstream');
  ok(e.tracking.get('origin/main') === e.branches.get('main'), 'push updates origin/main');

  r = e.run('git push');
  ok(r.error, 'a bare push still needs an upstream');
  includes(r.output, 'git push --set-upstream origin main', 'upstream hint names the remote');

  r = e.run('git push -u origin main');
  ok(!r.error, 'push -u on an up-to-date branch succeeds');
  includes(r.output, "set up to track 'origin/main'", 'push -u reports the new upstream');
  ok(e.upstreams.get('main') === 'origin/main', 'push -u records the upstream');
  ok(!e.run('git push').error, 'a bare push works once the upstream exists');

  r = e.run('git push notorigin main');
  ok(r.error, 'pushing to an unknown remote is rejected');
  includes(r.output, "fatal: 'notorigin' does not appear to be a git repository", 'unknown-remote message');
  ok(e.run('git fetch upstream').error, 'fetching an unknown remote is rejected');
  ok(e.run('git pull upstream main').error, 'pulling an unknown remote is rejected');

  // origin/<branch> must still resolve, decorate and reach the graph
  ok(e.resolveRef('origin/main') === e.branches.get('main'), 'origin/main resolves to a commit');
  includes(e.run('git log --oneline').output, 'origin/main', 'log decorates origin/main');
  ok(e.getGraph().remoteBranches.some((b) => b.name === 'origin/main'), 'graph exposes origin/main');

  // a second remote keeps its own tracking ref
  e.run('git remote add fork https://github.com/you/p.git');
  e.run('git push fork main');
  ok(e.remotes.fork.branches.main === e.branches.get('main'), 'the second remote received the push');
  ok(e.tracking.get('fork/main') === e.branches.get('main'), 'fork/main is tracked separately');
  ok(e.upstreams.get('main') === 'origin/main', 'pushing to a second remote leaves the upstream alone');
}

/* ---- 15. git commit --amend ---- */
{
  const e = new GitEngine();
  e.run('git init');
  ok(e.run('git commit --amend -m "nope"').error, 'amend with no commits is an error');

  e.run('echo "v1" > a.txt'); e.run('git add .'); e.run('git commit -m "frist commit"');
  const original = e.branches.get('main');

  let r = e.run('git commit --amend -m "first commit"');
  ok(!r.error, 'amend succeeds');
  includes(r.output, '(root-commit)', 'amending the root commit keeps the root-commit tag');
  ok(e.branches.get('main') !== original, 'amend replaces the commit (history is rewritten)');
  ok(e.ancestorsOf(e.branches.get('main')).size === 1, 'amend does not add a commit');
  ok(e.headCommit().message === 'first commit', 'amend applies the new message');
  ok(e.reflog[0].desc.startsWith('commit (amend)'), 'amend is recorded in the reflog');
  ok(!e.getGraph().commits.some((c) => c.id === original), 'the replaced commit leaves the graph');

  // amend also folds in whatever is staged
  e.run('echo "v2" > a.txt'); e.run('git add a.txt');
  e.run('git commit --amend -m "first commit, fixed"');
  ok(e.headCommit().tree['a.txt'] === 'v2\n', 'amend folds staged changes into the commit');
  ok(e.ancestorsOf(e.branches.get('main')).size === 1, 'still a single commit');

  // no -m keeps the existing message
  e.run('echo "v3" > a.txt'); e.run('git add a.txt'); e.run('git commit --amend');
  ok(e.headCommit().message === 'first commit, fixed', 'amend without -m reuses the message');
  ok(e.headCommit().tree['a.txt'] === 'v3\n', 'amend without -m still updates the tree');

  // a second commit amends without disturbing its parent
  e.run('echo "b" > b.txt'); e.run('git add .'); e.run('git commit -m "second"');
  const parentBefore = e.headCommit().parents[0];
  e.run('git commit --amend -m "second, better"');
  ok(e.headCommit().parents[0] === parentBefore, 'amend keeps the original parent');
  ok(e.ancestorsOf(e.branches.get('main')).size === 2, 'amend keeps the rest of the history');
}

/* ---- 16. git stash ---- */
{
  const e = new GitEngine();
  e.run('git init'); e.run('echo "clean" > a.txt'); e.run('git add .'); e.run('git commit -m one');

  ok(e.run('git stash').output === 'No local changes to save', 'stash with a clean tree says so');

  e.run('echo "dirty" > a.txt');
  e.run('echo "new" > untracked.txt');
  let r = e.run('git stash');
  includes(r.output, 'Saved working directory and index state WIP on main:', 'stash reports what it saved');
  ok(e.fs.get('a.txt') === 'clean\n', 'stash restores the tracked file to HEAD');
  ok(e.fs.get('untracked.txt') === 'new\n', 'stash leaves untracked files in place');
  ok(e.statuses().unstaged.length === 0, 'the working tree is clean after stashing');
  includes(e.run('git stash list').output, 'stash@{0}: WIP on main:', 'stash list shows the entry');

  r = e.run('git stash pop');
  ok(e.fs.get('a.txt') === 'dirty\n', 'pop brings the changes back');
  includes(r.output, 'Dropped refs/stash@{0}', 'pop reports the drop');
  ok(e.run('git stash list').output === '', 'the stash is empty after popping');
  ok(e.run('git stash pop').error, 'popping an empty stash is an error');
}
{
  // staged work is stashed too; `apply` keeps the entry, `drop` removes it
  const e = new GitEngine();
  e.run('git init'); e.run('echo "clean" > a.txt'); e.run('git add .'); e.run('git commit -m one');
  e.run('echo "staged" > a.txt'); e.run('git add a.txt');
  e.run('git stash');
  ok(e.index.get('a.txt') === 'clean\n', 'stash resets the index to HEAD');
  e.run('git stash apply');
  ok(e.index.get('a.txt') === 'staged\n', 'apply restores the index');
  ok(e.stash.length === 1, 'apply keeps the stash entry');
  e.run('git stash drop');
  ok(e.stash.length === 0, 'drop removes the entry');

  const named = new GitEngine();
  named.run('git init'); named.run('touch a.txt'); named.run('git add .'); named.run('git commit -m one');
  named.run('echo "wip" > a.txt');
  named.run('git stash -m "half-finished idea"');
  includes(named.run('git stash list').output, 'half-finished idea', 'stash -m labels the entry');
}
{
  // the advice printed by a blocked checkout now actually works
  const e = new GitEngine();
  e.run('git init'); e.run('echo "base" > a.txt'); e.run('git add .'); e.run('git commit -m one');
  e.run('git switch -c feature'); e.run('echo "feature" > a.txt'); e.run('git add .'); e.run('git commit -m f');
  e.run('git switch main');
  e.run('echo "wip" > a.txt');
  const blocked = e.run('git switch feature');
  ok(blocked.error, 'a dirty tree blocks the switch');
  includes(blocked.output, 'stash them', 'the error suggests stashing');
  ok(!e.run('git stash').error, 'git stash is a real command in the sandbox');
  ok(!e.run('git switch feature').error, 'the switch works after stashing');
}

/* ---- 17. git add and .gitignore ---- */
{
  const e = new GitEngine();
  e.run('git init');
  e.run('echo "*.log" > .gitignore');
  e.run('echo "boom" > debug.log');

  const r = e.run('git add debug.log');
  ok(r.error, 'adding an ignored path by name is an error');
  includes(r.output, 'The following paths are ignored by one of your .gitignore files', 'ignored-path message');
  includes(r.output, 'Use -f if you really want to add them', 'ignored-path hint offers -f');
  ok(!e.index.has('debug.log'), 'the ignored path was not staged');

  ok(!e.run('git add -f debug.log').error, 'git add -f overrides the ignore');
  ok(e.index.has('debug.log'), 'git add -f actually stages it');

  const bulk = new GitEngine();
  bulk.run('git init');
  bulk.run('echo "*.log" > .gitignore');
  bulk.run('echo "boom" > debug.log');
  bulk.run('echo "keep" > notes.txt');
  bulk.run('git add .');
  ok(!bulk.index.has('debug.log'), 'git add . silently skips ignored files');
  ok(bulk.index.has('notes.txt'), 'git add . stages everything else');
  ok(bulk.index.has('.gitignore'), 'git add . stages .gitignore itself');
}

/* ---- 18. git clone explains the sandbox instead of "not a git command" ---- */
{
  const e = new GitEngine();
  const r = e.run('git clone https://github.com/me/project.git');
  ok(r.error, 'clone is an error in the sandbox');
  includes(r.output, "Cloning into 'project'", 'clone echoes the target folder');
  includes(r.output, 'no network', 'clone explains why it cannot work');
  ok(!r.output.includes('is not a git command'), 'clone is not reported as unknown');
}

/* ---- 19. applySetup flags unknown ops instead of ignoring them ---- */
{
  const e = new GitEngine();
  e.applySetup([{ op: 'init' }, { op: 'wrte', path: 'a.txt', content: 'oops' }]);
  ok(e.setupWarnings.length === 1, 'a typo\'d setup op is recorded');
  includes(e.setupWarnings[0], 'wrte', 'the warning names the bad op');

  const good = new GitEngine();
  good.applySetup([{ op: 'init' }, { op: 'write', path: 'a.txt', content: 'fine' }]);
  ok(good.setupWarnings.length === 0, 'valid setup ops produce no warnings');
  ok(SETUP_OPS.includes('remoteCommit'), 'SETUP_OPS lists every documented op');
}

/* ---- 20. advanceSteps: the guided-walkthrough cascade ---- */
{
  const steps = [
    { expect: [{ kind: 'repoInitialized' }] },
    { expect: [{ kind: 'fileStaged', path: 'a.txt' }] },
    { expect: [{ kind: 'commitCount', min: 1 }] },
    { expect: [{ kind: 'commandRan', command: 'git', sub: 'status' }] },
  ];
  const e = new GitEngine();
  ok(advanceSteps(e, steps, 0) === 0, 'no steps complete before anything is run');
  e.run('git init');
  ok(advanceSteps(e, steps, 0) === 1, 'git init completes step 1');
  e.run('echo "hi" > a.txt');
  e.run('git add a.txt');
  ok(advanceSteps(e, steps, 1) === 2, 'staging completes step 2');
  // one command satisfies the commit step; the commandRan step must NOT cascade
  e.run('git commit -m "x"');
  ok(advanceSteps(e, steps, 2) === 3, 'committing completes step 3 but not the commandRan step');
  e.run('git status');
  ok(advanceSteps(e, steps, 3) === 4, 'running the named command completes the last step');

  // `git commit -am` stages and commits in one go, satisfying a "it's
  // committed" step and a "your tree is clean" step from a single command.
  const cascade = [
    { expect: [{ kind: 'fileCommitted', path: 'a.txt', contains: 'updated' }] },
    { expect: [{ kind: 'cleanWorkingTree' }] },
  ];
  const c = new GitEngine();
  c.run('git init'); c.run('echo "first" > a.txt'); c.run('git add .'); c.run('git commit -m one');
  c.run('echo "updated" > a.txt');
  ok(advanceSteps(c, cascade, 0) === 0, 'neither step passes on an uncommitted edit');
  c.run('git commit -am two');
  ok(advanceSteps(c, cascade, 0) === 2, 'one command can complete two state-based steps');
}

/* ---- 21. git diff between revisions, and git show (module 4 needs these) ---- */
{
  const e = new GitEngine();
  e.run('git init');
  e.run('echo "line one" > notes.txt');
  e.run('git add .'); e.run('git commit -m "first"');
  e.run('echo "line two" >> notes.txt');
  e.run('echo "readme" > readme.md');
  e.run('git add .'); e.run('git commit -m "second"');
  e.run('echo "line three" >> notes.txt');   // uncommitted working-tree change

  // two revisions: commit-to-commit
  let r = e.run('git diff HEAD~1 HEAD');
  includes(r.output, '+line two', 'diff A B shows the added line');
  includes(r.output, 'new file mode 100644', 'diff A B reports a file added between commits');
  includes(r.output, 'readme.md', 'diff A B names the new file');
  ok(!r.output.includes('line three'), 'diff A B ignores uncommitted work');

  // one revision: commit vs working tree
  r = e.run('git diff HEAD');
  includes(r.output, '+line three', 'diff <ref> compares against the working tree');
  ok(!r.output.includes('readme.md'), 'diff <ref> skips files that did not change');

  // one revision, --staged: commit vs index
  e.run('git add notes.txt');
  r = e.run('git diff HEAD --staged');
  includes(r.output, '+line three', 'diff <ref> --staged compares against the index');
  ok(e.run('git diff').output === '', 'nothing left unstaged after adding');

  // path filters still work, and are not mistaken for revisions
  r = e.run('git diff HEAD notes.txt');
  includes(r.output, 'notes.txt', 'diff <ref> <path> filters by path');
  ok(!r.output.includes('readme.md'), 'the path filter excludes other files');

  // a nonsense argument is an error, not silence
  r = e.run('git diff nosuchthing');
  ok(r.error, 'diff with an unknown argument errors');
  includes(r.output, "fatal: ambiguous argument 'nosuchthing'", 'unknown diff argument message');

  // git show
  r = e.run('git show HEAD');
  includes(r.output, 'commit ', 'show prints the commit header');
  includes(r.output, 'Author: Learner', 'show prints the author');
  includes(r.output, '    second', 'show prints the commit message');
  includes(r.output, '+line two', 'show prints the diff the commit introduced');
  ok(!e.run('git show').error, 'git show defaults to HEAD');

  r = e.run('git show HEAD~1');
  includes(r.output, '    first', 'show works on an older commit');
  includes(r.output, 'new file mode 100644', 'show reports the root commit as adding files');

  r = e.run('git show nope');
  ok(r.error, 'show with a bad revision errors');
  includes(r.output, 'unknown revision', 'bad-revision message');
}
{
  // show on a merge commit lists both parents
  const e = new GitEngine();
  e.run('git init');
  e.run('echo "base" > a.txt'); e.run('git add .'); e.run('git commit -m base');
  e.run('git switch -c feature');
  e.run('echo "feature" > f.txt'); e.run('git add .'); e.run('git commit -m feat');
  e.run('git switch main');
  e.run('echo "main" > m.txt'); e.run('git add .'); e.run('git commit -m mainwork');
  e.run('git merge feature');
  const r = e.run('git show HEAD');
  includes(r.output, 'Merge: ', 'show marks a merge commit with its parents');
}

/* ---- 22. switching branches must not destroy uncommitted work ---- */
{
  const e = new GitEngine();
  e.run('git init');
  e.run('echo "shared" > shared.txt');
  e.run('echo "base" > other.txt');
  e.run('git add .'); e.run('git commit -m base');
  e.run('git switch -c feature');
  e.run('echo "feature version" > other.txt');
  e.run('git add .'); e.run('git commit -m feat');
  e.run('git switch main');

  // shared.txt is byte-identical in both commits, so real git does not touch it
  // on a switch — an uncommitted edit to it comes along with you.
  e.run('echo "my uncommitted work" > shared.txt');
  const r = e.run('git switch feature');
  ok(!r.error, 'switching is allowed when only an unchanged-between-branches file is dirty');
  ok(e.fs.get('shared.txt') === 'my uncommitted work\n', 'the uncommitted edit survives the switch');
  ok(e.fs.get('other.txt') === 'feature version\n', 'a file that DOES differ is updated to the new branch');
  const st = e.statuses();
  ok(st.unstaged.some((s) => s.path === 'shared.txt'), 'the carried-over edit still shows as unstaged');

  // and it survives the trip back
  e.run('git switch main');
  ok(e.fs.get('shared.txt') === 'my uncommitted work\n', 'the edit survives switching back too');
  ok(e.fs.get('other.txt') === 'base\n', 'the differing file follows the branch back');

  // a dirty file that DOES differ between the branches is still refused
  e.run('echo "conflicting edit" > other.txt');
  const blocked = e.run('git switch feature');
  ok(blocked.error, 'a dirty file that differs between branches still blocks the switch');
  includes(blocked.output, 'other.txt', 'the block names the offending file');

  // a locally deleted but otherwise-identical file stays deleted
  const d = new GitEngine();
  d.run('git init');
  d.run('echo "keep" > keep.txt'); d.run('echo "x" > x.txt');
  d.run('git add .'); d.run('git commit -m one');
  d.run('git switch -c side'); d.run('echo "y" > x.txt'); d.run('git add .'); d.run('git commit -m two');
  d.run('git switch main');
  d.run('rm keep.txt');
  d.run('git switch side');
  ok(!d.fs.has('keep.txt'), 'a local deletion of an unchanged file is not silently undone');
}

/* ---- 23. reflog entries name the ref you reset to ---- */
{
  const e = new GitEngine();
  e.run('git init');
  e.run('echo a > a.txt'); e.run('git add .'); e.run('git commit -m "one"');
  e.run('echo b > b.txt'); e.run('git add .'); e.run('git commit -m "two"');

  e.run('git reset --hard HEAD~1');
  let log = e.run('git reflog').output;
  includes(log, 'reset: moving to HEAD~1', 'reflog names the ref after --hard');
  ok(!log.includes('[object Object]'), 'reflog never stringifies a tree into the entry');

  e.run('git reset --soft HEAD');
  e.run('git reset --mixed HEAD');
  log = e.run('git reflog').output;
  ok(!log.includes('[object Object]'), 'no reset mode corrupts the reflog');

  // the reflog is module 9's safety net, so the sha must actually be usable
  const rescued = log.split('\n').find((l) => l.includes('commit: two'));
  ok(!!rescued, 'the discarded commit is still findable in the reflog');
  const sha = rescued.slice(0, 7);
  ok(e.resolveRef(sha) != null, 'the reflog sha resolves, so the work can be recovered');
}

/* ---- 24. repeated -m writes a subject and a body, as real git does ---- */
{
  const e = new GitEngine();
  e.run('git init'); e.run('touch x.txt'); e.run('git add .');
  const r = e.run('git commit -m "Add the greeting" -m "Explains why we needed it."');
  ok(!r.error, 'commit with two -m flags succeeds');
  ok(e.headCommit().message === 'Add the greeting\n\nExplains why we needed it.',
    'repeated -m joins with a blank line');
  includes(r.output, '] Add the greeting', 'the commit line shows only the subject');
  ok(!r.output.includes('Explains why'), 'the commit line does not spill the body');

  const full = e.run('git log').output;
  includes(full, '    Add the greeting', 'log indents the subject by four spaces');
  includes(full, '    Explains why we needed it.', 'log indents the body too');

  const one = e.run('git log --oneline').output;
  includes(one, 'Add the greeting', 'oneline shows the subject');
  ok(!one.includes('Explains why'), 'oneline stops at the subject');

  // three parts, and the single-flag form still behaves
  const t = new GitEngine();
  t.run('git init'); t.run('touch y.txt'); t.run('git add .');
  t.run('git commit -m "a" -m "b" -m "c"');
  ok(t.headCommit().message === 'a\n\nb\n\nc', 'three -m flags join with blank lines');

  const s = new GitEngine();
  s.run('git init'); s.run('touch z.txt'); s.run('git add .');
  s.run('git commit -m "just a subject"');
  ok(s.headCommit().message === 'just a subject', 'a single -m is unchanged');
  ok(s.run('git commit -m').error, 'a bare -m with no text is still an error');

  // amend and stash summaries show subjects, not whole bodies
  s.run('echo 1 > z.txt'); s.run('git add .');
  const am = s.run('git commit --amend -m "new subject" -m "new body"');
  includes(am.output, '] new subject', 'amend reports the subject');
  ok(!am.output.includes('new body'), 'amend does not spill the body');
  s.run('echo 2 > z.txt');
  includes(s.run('git stash').output, 'WIP on main:', 'stash summarises with the subject');
  ok(!s.run('git stash list').output.includes('new body'), 'stash list shows no body text');
}

/* ---- report ---- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
