/* ============================================================================
 * first-commit — simulated Git engine
 * ----------------------------------------------------------------------------
 * Pure JavaScript. NO DOM dependency. Unit-testable in Node.
 *
 * Models an in-memory fake filesystem plus a fake repository:
 *   - working directory  : this.fs      (Map path -> content string)
 *   - staging area/index : this.index   (Map path -> content string)
 *   - object store       : this.commits (Map sha -> commit object)
 *   - branches           : this.branches (Map name -> sha)
 *   - HEAD               : { type:'branch', ref } | { type:'commit', id }
 *   - simulated remote   : this.remotes.origin { url, branches: {name: sha} }
 *   - remote-tracking    : this.tracking (Map 'main' -> sha, i.e. origin/main)
 *
 * Output strings are formatted to match real git's output as closely as is
 * practical, so learners are not surprised when they graduate to real git.
 * ========================================================================== */

const BASE_TIME = Date.UTC(2026, 0, 5, 9, 0, 0); // deterministic fake clock
const REPO_PATH = '/home/learner/project';
const AUTHOR = 'Learner <learner@example.com>';

/* ------------------------------- utilities ------------------------------- */

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function makeSha(seed) {
  let out = '';
  let salt = 0;
  while (out.length < 40) {
    out += hashStr(seed + '|' + salt++).toString(16).padStart(8, '0');
  }
  return out.slice(0, 40);
}

const short = (sha) => sha.slice(0, 7);

function splitLines(text) {
  if (text === '' || text == null) return [];
  return text.replace(/\n$/, '').split('\n');
}

/** Simple LCS line diff. Returns ops: [{t:' '|'-'|'+', line}] */
function diffLines(aText, bText) {
  const a = splitLines(aText);
  const b = splitLines(bText);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', line: a[i] }); i++; }
    else { ops.push({ t: '+', line: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: '-', line: a[i++] });
  while (j < m) ops.push({ t: '+', line: b[j++] });
  return ops;
}

function countChanges(aText, bText) {
  const ops = diffLines(aText, bText);
  let add = 0, del = 0;
  for (const o of ops) { if (o.t === '+') add++; else if (o.t === '-') del++; }
  return { add, del };
}

/** Build unified-diff hunks with 3 lines of context from a diff op list. */
function unifiedHunks(ops, ctx = 3) {
  const include = new Array(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.t !== ' ') {
      for (let k = Math.max(0, idx - ctx); k <= Math.min(ops.length - 1, idx + ctx); k++) include[k] = true;
    }
  });
  const hunks = [];
  let i = 0, aPos = 1, bPos = 1;
  while (i < ops.length) {
    if (!include[i]) {
      if (ops[i].t !== '+') aPos++;
      if (ops[i].t !== '-') bPos++;
      i++;
      continue;
    }
    const aStart = aPos, bStart = bPos;
    const lines = [];
    let aLen = 0, bLen = 0;
    while (i < ops.length && include[i]) {
      const o = ops[i];
      lines.push(o.t + o.line);
      if (o.t !== '+') { aPos++; aLen++; }
      if (o.t !== '-') { bPos++; bLen++; }
      i++;
    }
    const aS = aLen === 0 ? aStart - 1 : aStart;
    const bS = bLen === 0 ? bStart - 1 : bStart;
    hunks.push(`@@ -${aS}${aLen === 1 ? '' : ',' + aLen} +${bS}${bLen === 1 ? '' : ',' + bLen} @@`);
    hunks.push(...lines);
  }
  return hunks;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function gitDate(seq) {
  const d = new Date(BASE_TIME + seq * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()} +0000`;
}

/** Tokenize a command line, honoring single/double quotes. */
function tokenize(line) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c; has = true;
    } else if (c === ' ' || c === '\t') {
      if (has || cur.length) { tokens.push(cur); cur = ''; has = false; }
    } else {
      cur += c;
    }
  }
  if (has || cur.length) tokens.push(cur);
  return tokens;
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

/* --------------------------------- engine -------------------------------- */

export class GitEngine {
  constructor() {
    this.resetAll();
  }

  resetAll() {
    this.fs = new Map();
    this.initialized = false;
    this.index = new Map();
    this.commits = new Map();
    this.branches = new Map();
    this.HEAD = { type: 'branch', ref: 'main' };
    this.remotes = {};                // { origin: { url, branches: {name: sha} } }
    this.tracking = new Map();        // 'main' -> sha  (rendered as origin/main)
    this.upstreams = new Map();       // local branch -> 'origin/main'
    this.mergeState = null;           // { mergeHead, fromName, conflicts:Set, preState }
    this.reflog = [];                 // [{ sha, desc }], newest first
    this.seq = 0;
    this.lastCommand = null;          // { name, sub, ok, raw } — semantic record
    this.setupSnapshot = null;        // fs snapshot taken after applySetup()
    this.setupOps = null;
  }

  /* ----------------------------- public API ------------------------------ */

  /** Run one command line. Returns { output, error, clear }. */
  run(line) {
    const raw = String(line || '').trim();
    if (!raw) return { output: '', error: false };
    const tokens = tokenize(raw);
    const name = tokens[0];
    let res;
    try {
      if (name === 'git') res = this.git(tokens.slice(1));
      else res = this.shell(name, tokens.slice(1));
    } catch (e) {
      res = { output: `sandbox error: ${e.message}`, error: true };
    }
    this.lastCommand = {
      name,
      sub: name === 'git' ? (tokens[1] || '') : '',
      ok: !res.error,
      raw,
    };
    return res;
  }

  /* ----------------------------- shell layer ----------------------------- */

  shell(name, args) {
    switch (name) {
      case 'ls': {
        const all = args.includes('-a') || args.includes('-la') || args.includes('-al');
        const names = new Set();
        for (const p of this.fs.keys()) {
          const top = p.includes('/') ? p.split('/')[0] + '/' : p;
          names.add(top);
        }
        const list = [...names].sort();
        if (all) {
          const dot = ['.', '..'];
          if (this.initialized) dot.push('.git/');
          list.unshift(...dot);
        }
        return { output: list.join('\n'), error: false };
      }
      case 'pwd':
        return { output: '~/project', error: false };
      case 'cat': {
        if (!args.length) return { output: 'usage: cat <file>', error: true };
        const out = [];
        for (const p of args) {
          if (!this.fs.has(p)) return { output: `cat: ${p}: No such file or directory`, error: true };
          out.push(this.fs.get(p).replace(/\n$/, ''));
        }
        return { output: out.join('\n'), error: false };
      }
      case 'touch': {
        if (!args.length) return { output: 'usage: touch <file>', error: true };
        for (const p of args) if (!this.fs.has(p)) this.fs.set(p, '');
        return { output: '', error: false };
      }
      case 'rm': {
        const paths = args.filter((a) => !a.startsWith('-'));
        if (!paths.length) return { output: 'usage: rm <file>', error: true };
        for (const p of paths) {
          if (!this.fs.has(p)) return { output: `rm: cannot remove '${p}': No such file or directory`, error: true };
          this.fs.delete(p);
        }
        return { output: '', error: false };
      }
      case 'echo': {
        // Support: echo text > file, echo text >> file, echo text
        const gt = args.lastIndexOf('>');
        const gg = args.lastIndexOf('>>');
        if (gg !== -1 && gg === args.length - 2) {
          const file = args[args.length - 1];
          const text = args.slice(0, gg).join(' ');
          const prev = (this.fs.get(file) || '').replace(/\n$/, '');
          this.fs.set(file, (prev === '' ? '' : prev + '\n') + text + '\n');
          return { output: '', error: false };
        }
        if (gt !== -1 && gt === args.length - 2) {
          const file = args[args.length - 1];
          const text = args.slice(0, gt).join(' ');
          this.fs.set(file, text + '\n');
          return { output: '', error: false };
        }
        return { output: args.join(' '), error: false };
      }
      case 'clear':
        return { output: '', error: false, clear: true };
      default:
        return { output: `${name}: command not found`, error: true };
    }
  }

  /* ------------------------------ git layer ------------------------------ */

  git(args) {
    if (!args.length || args[0] === '--help' || args[0] === 'help') {
      return { output: this.usage(), error: false };
    }
    if (args[0] === '--version') return { output: 'git version 2.45.0.sandbox', error: false };
    const sub = args[0];
    const rest = args.slice(1);
    const needRepo = !['init', 'clone'].includes(sub);
    if (needRepo && !this.initialized) {
      return { output: 'fatal: not a git repository (or any of the parent directories): .git', error: true };
    }
    switch (sub) {
      case 'init': return this.cmdInit();
      case 'status': return this.cmdStatus();
      case 'add': return this.cmdAdd(rest);
      case 'restore': return this.cmdRestore(rest);
      case 'commit': return this.cmdCommit(rest);
      case 'log': return this.cmdLog(rest);
      case 'diff': return this.cmdDiff(rest);
      case 'branch': return this.cmdBranch(rest);
      case 'checkout': return this.cmdCheckout(rest, 'checkout');
      case 'switch': return this.cmdCheckout(rest, 'switch');
      case 'merge': return this.cmdMerge(rest);
      case 'reset': return this.cmdReset(rest);
      case 'revert': return this.cmdRevert(rest);
      case 'rebase': return this.cmdRebase(rest);
      case 'remote': return this.cmdRemote(rest);
      case 'push': return this.cmdPush(rest);
      case 'fetch': return this.cmdFetch(rest);
      case 'pull': return this.cmdPull(rest);
      case 'reflog': return this.cmdReflog(rest);
      default:
        return { output: `git: '${sub}' is not a git command. See 'git --help'.`, error: true };
    }
  }

  usage() {
    return [
      'usage: git <command> [<args>]',
      '',
      'Commands supported in this sandbox:',
      '   init       Create an empty Git repository',
      '   status     Show the working tree status',
      '   add        Add file contents to the staging area',
      '   restore    Restore working tree files (--staged to unstage)',
      '   commit     Record changes to the repository  (-m "message")',
      '   log        Show commit history  (--oneline)',
      '   diff       Show changes  (--staged for index vs last commit)',
      '   branch     List, create, or delete branches',
      '   switch     Switch branches  (-c to create)',
      '   checkout   Switch branches or restore files',
      '   merge      Join branches together',
      '   reset      Move the current branch  (--soft | --mixed | --hard)',
      '   revert     Undo a commit with a new commit',
      '   rebase     Reapply commits on top of another branch',
      '   remote     Manage the simulated remote',
      '   push       Update the remote branch',
      '   fetch      Download remote history',
      '   pull       Fetch and merge remote changes',
      '   reflog     Show where HEAD has been',
    ].join('\n');
  }

  /* ------------------------------ ref helpers ---------------------------- */

  headCommitId() {
    if (this.HEAD.type === 'commit') return this.HEAD.id;
    return this.branches.get(this.HEAD.ref) || null;
  }

  headCommit() {
    const id = this.headCommitId();
    return id ? this.commits.get(id) : null;
  }

  headTree() {
    const c = this.headCommit();
    return c ? c.tree : {};
  }

  currentBranch() {
    return this.HEAD.type === 'branch' ? this.HEAD.ref : null;
  }

  /** Resolve a ref string (HEAD, HEAD~2, branch, origin/branch, sha prefix). */
  resolveRef(ref) {
    if (!ref) return null;
    let base = ref;
    let ops = '';
    const m = ref.match(/^([^~^]+)([~^].*)?$/);
    if (m) { base = m[1]; ops = m[2] || ''; }
    let id = null;
    if (base === 'HEAD') id = this.headCommitId();
    else if (this.branches.has(base)) id = this.branches.get(base);
    else if (base.startsWith('origin/')) {
      const b = base.slice('origin/'.length);
      id = this.tracking.get(b) || null;
    } else if (/^[0-9a-f]{4,40}$/.test(base)) {
      const matches = [...this.commits.keys()].filter((k) => k.startsWith(base));
      if (matches.length === 1) id = matches[0];
    }
    if (!id) return null;
    // apply ~N / ^ suffixes
    let rest = ops;
    while (rest.length) {
      if (rest[0] === '~') {
        const nm = rest.slice(1).match(/^\d+/);
        const n = nm ? parseInt(nm[0], 10) : 1;
        rest = rest.slice(1 + (nm ? nm[0].length : 0));
        for (let i = 0; i < n; i++) {
          const c = this.commits.get(id);
          if (!c || !c.parents.length) return null;
          id = c.parents[0];
        }
      } else if (rest[0] === '^') {
        rest = rest.slice(1);
        const c = this.commits.get(id);
        if (!c || !c.parents.length) return null;
        id = c.parents[0];
      } else return null;
    }
    return id;
  }

  ancestorsOf(id) {
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || seen.has(cur)) continue;
      seen.add(cur);
      const c = this.commits.get(cur);
      if (c) stack.push(...c.parents);
    }
    return seen;
  }

  isAncestor(a, b) { // is a an ancestor of (or equal to) b?
    return this.ancestorsOf(b).has(a);
  }

  mergeBase(a, b) {
    const ancA = this.ancestorsOf(a);
    let best = null;
    for (const id of this.ancestorsOf(b)) {
      if (ancA.has(id)) {
        const c = this.commits.get(id);
        if (!best || c.seq > best.seq) best = c;
      }
    }
    return best ? best.id : null;
  }

  logReflog(sha, desc) {
    if (sha) this.reflog.unshift({ sha, desc });
  }

  /* ----------------------------- status model ---------------------------- */

  ignoredPatterns() {
    const content = this.fs.get('.gitignore');
    if (!content) return [];
    return splitLines(content).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }

  isIgnored(path) {
    if (path === '.gitignore') return false;
    // Never ignore files already tracked
    if (this.index.has(path) || path in this.headTree()) return false;
    for (const pat of this.ignoredPatterns()) {
      if (pat.endsWith('/')) {
        if (path.startsWith(pat)) return true;
      } else if (pat.startsWith('*.')) {
        if (path.endsWith(pat.slice(1))) return true;
      } else if (path === pat) {
        return true;
      }
    }
    return false;
  }

  /** Classified file status, the source of truth for `git status` and the UI. */
  statuses() {
    const head = this.headTree();
    const staged = [];   // {path, kind:'new file'|'modified'|'deleted'}
    const unstaged = []; // {path, kind:'modified'|'deleted'}
    const untracked = [];
    const conflicted = this.mergeState ? [...this.mergeState.conflicts].sort() : [];
    const conflictSet = new Set(conflicted);

    const allPaths = new Set([
      ...this.fs.keys(), ...this.index.keys(), ...Object.keys(head),
    ]);
    for (const p of [...allPaths].sort()) {
      if (conflictSet.has(p)) continue;
      const inFs = this.fs.has(p);
      const inIdx = this.index.has(p);
      const inHead = p in head;
      const fsC = inFs ? this.fs.get(p) : null;
      const idxC = inIdx ? this.index.get(p) : null;
      const headC = inHead ? head[p] : null;

      // index vs HEAD  → staged changes
      if (inIdx && !inHead) staged.push({ path: p, kind: 'new file' });
      else if (inIdx && inHead && idxC !== headC) staged.push({ path: p, kind: 'modified' });
      else if (!inIdx && inHead) staged.push({ path: p, kind: 'deleted' });

      // working vs index → unstaged changes (only for tracked files)
      if (inIdx) {
        if (!inFs) unstaged.push({ path: p, kind: 'deleted' });
        else if (fsC !== idxC) unstaged.push({ path: p, kind: 'modified' });
      }

      // untracked: in fs, not in index, not in HEAD
      if (inFs && !inIdx && !inHead && !this.isIgnored(p)) untracked.push(p);
    }
    return { staged, unstaged, untracked, conflicted };
  }

  /* ------------------------------- commands ------------------------------ */

  cmdInit() {
    if (this.initialized) {
      return { output: `Reinitialized existing Git repository in ${REPO_PATH}/.git/`, error: false };
    }
    this.initialized = true;
    this.branches = new Map();
    this.HEAD = { type: 'branch', ref: 'main' };
    return { output: `Initialized empty Git repository in ${REPO_PATH}/.git/`, error: false };
  }

  cmdStatus() {
    const { staged, unstaged, untracked, conflicted } = this.statuses();
    const lines = [];
    const branch = this.currentBranch();
    if (branch) lines.push(`On branch ${branch}`);
    else lines.push(`HEAD detached at ${short(this.headCommitId())}`);

    if (this.mergeState) {
      if (conflicted.length) {
        lines.push('You have unmerged paths.');
        lines.push('  (fix conflicts and run "git commit")');
        lines.push('  (use "git merge --abort" to abort the merge)');
      } else {
        lines.push('All conflicts fixed but you are still in a merge.');
        lines.push('  (use "git commit" to conclude merge)');
      }
      lines.push('');
    } else if (!this.headCommit()) {
      lines.push('');
      lines.push('No commits yet');
      lines.push('');
    } else {
      lines.push('');
    }

    if (staged.length) {
      lines.push('Changes to be committed:');
      lines.push('  (use "git restore --staged <file>..." to unstage)');
      for (const s of staged) lines.push(`\t${(s.kind + ':').padEnd(12)}${s.path}`);
      lines.push('');
    }
    if (conflicted.length) {
      lines.push('Unmerged paths:');
      lines.push('  (use "git add <file>..." to mark resolution)');
      for (const p of conflicted) lines.push(`\tboth modified:   ${p}`);
      lines.push('');
    }
    if (unstaged.length) {
      lines.push('Changes not staged for commit:');
      lines.push('  (use "git add <file>..." to update what will be committed)');
      lines.push('  (use "git restore <file>..." to discard changes in working directory)');
      for (const s of unstaged) lines.push(`\t${(s.kind + ':').padEnd(12)}${s.path}`);
      lines.push('');
    }
    if (untracked.length) {
      lines.push('Untracked files:');
      lines.push('  (use "git add <file>..." to include in what will be committed)');
      for (const p of untracked) lines.push(`\t${p}`);
      lines.push('');
    }

    if (!staged.length && !conflicted.length) {
      if (unstaged.length) {
        lines.push('no changes added to commit (use "git add" and/or "git commit -a")');
      } else if (untracked.length) {
        lines.push('nothing added to commit but untracked files present (use "git add" to track)');
      } else if (!this.mergeState) {
        lines.push('nothing to commit, working tree clean');
      }
    }
    while (lines[lines.length - 1] === '') lines.pop();
    return { output: lines.join('\n'), error: false };
  }

  cmdAdd(args) {
    const paths = args.filter((a) => !a.startsWith('-'));
    const all = paths.includes('.') || args.includes('-A') || args.includes('--all');
    if (!paths.length && !all) {
      return { output: "Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?", error: true };
    }
    const head = this.headTree();
    const stageOne = (p) => {
      if (this.fs.has(p)) this.index.set(p, this.fs.get(p));
      else this.index.delete(p); // stage a deletion
      if (this.mergeState) this.mergeState.conflicts.delete(p);
    };
    if (all) {
      for (const p of this.fs.keys()) if (!this.isIgnored(p)) stageOne(p);
      for (const p of [...this.index.keys()]) if (!this.fs.has(p)) stageOne(p);
      for (const p of Object.keys(head)) if (!this.fs.has(p)) stageOne(p);
      return { output: '', error: false };
    }
    for (const p of paths) {
      const known = this.fs.has(p) || this.index.has(p) || p in head;
      if (!known) {
        return { output: `fatal: pathspec '${p}' did not match any files`, error: true };
      }
    }
    for (const p of paths) stageOne(p);
    return { output: '', error: false };
  }

  cmdRestore(args) {
    const stagedMode = args.includes('--staged');
    const paths = args.filter((a) => !a.startsWith('-'));
    if (!paths.length) return { output: 'fatal: you must specify path(s) to restore', error: true };
    const head = this.headTree();
    for (const p of paths) {
      if (stagedMode) {
        if (p in head) this.index.set(p, head[p]);
        else this.index.delete(p);
      } else {
        if (this.index.has(p)) this.fs.set(p, this.index.get(p));
        else if (p in head) this.fs.set(p, head[p]);
        else return { output: `error: pathspec '${p}' did not match any file(s) known to git`, error: true };
      }
    }
    return { output: '', error: false };
  }

  makeCommit(message, parents, tree) {
    const seq = ++this.seq;
    const id = makeSha(`${seq}|${message}|${parents.join(',')}|${JSON.stringify(tree)}`);
    const commit = { id, parents, message, tree, seq, branchHint: this.currentBranch() };
    this.commits.set(id, commit);
    return commit;
  }

  statBlock(oldTree, newTree) {
    const lines = [];
    let files = 0, adds = 0, dels = 0;
    const paths = [...new Set([...Object.keys(oldTree), ...Object.keys(newTree)])].sort();
    const modeLines = [];
    let widest = 0;
    const perFile = [];
    for (const p of paths) {
      const a = oldTree[p], b = newTree[p];
      if (a === b) continue;
      const { add, del } = countChanges(a || '', b || '');
      if (add === 0 && del === 0 && (p in oldTree) === (p in newTree)) continue;
      files++; adds += add; dels += del;
      widest = Math.max(widest, p.length);
      perFile.push({ p, add, del });
      if (!(p in oldTree)) modeLines.push(` create mode 100644 ${p}`);
      if (!(p in newTree)) modeLines.push(` delete mode 100644 ${p}`);
    }
    for (const f of perFile) {
      const total = f.add + f.del;
      const bar = '+'.repeat(Math.min(f.add, 20)) + '-'.repeat(Math.min(f.del, 20));
      lines.push(` ${f.p.padEnd(widest)} | ${total} ${bar}`);
    }
    const parts = [`${plural(files, 'file')} changed`];
    if (adds) parts.push(`${plural(adds, 'insertion')}(+)`);
    if (dels) parts.push(`${plural(dels, 'deletion')}(-)`);
    lines.push(' ' + parts.join(', '));
    lines.push(...modeLines);
    return { lines, files, adds, dels };
  }

  cmdCommit(args) {
    // parse -m "msg" and -a / -am
    let message = null;
    let stageTracked = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-m' || a === '--message') { message = args[i + 1]; i++; }
      else if (a === '-am' || a === '-ma') { stageTracked = true; message = args[i + 1]; i++; }
      else if (a === '-a' || a === '--all') stageTracked = true;
    }
    if (stageTracked) {
      for (const p of [...this.index.keys()]) {
        if (this.fs.has(p)) this.index.set(p, this.fs.get(p));
        else this.index.delete(p);
      }
    }

    if (this.mergeState) {
      if (this.mergeState.conflicts.size) {
        return {
          output: 'error: Committing is not possible because you have unmerged files.\n' +
            "hint: Fix them up in the work tree, and then use 'git add <file>'\n" +
            'hint: as appropriate to mark resolution and make a commit.\n' +
            'fatal: Exiting because of an unresolved conflict.',
          error: true,
        };
      }
      const msg = message || `Merge branch '${this.mergeState.fromName}'`;
      const parentId = this.mergeState.preState.headId;
      const tree = Object.fromEntries(this.index);
      const parents = [parentId, this.mergeState.mergeHead];
      const c = this.makeCommit(msg, parents, tree);
      const br = this.currentBranch();
      if (br) this.branches.set(br, c.id); else this.HEAD = { type: 'commit', id: c.id };
      this.mergeState = null;
      this.logReflog(c.id, `commit (merge): ${msg}`);
      return { output: `[${br || 'detached HEAD'} ${short(c.id)}] ${msg}`, error: false };
    }

    if (message == null) {
      return {
        output: 'error: no commit message given.\n' +
          '(real git would open your text editor here — in this sandbox,\n' +
          ' pass a message directly:  git commit -m "your message")',
        error: true,
      };
    }

    const parent = this.headCommit();
    const parentTree = parent ? parent.tree : {};
    const newTree = Object.fromEntries(this.index);
    const same = JSON.stringify(this.sortedTree(parentTree)) === JSON.stringify(this.sortedTree(newTree));
    if (same) {
      const { unstaged, untracked } = this.statuses();
      const lines = [];
      if (unstaged.length || untracked.length) {
        lines.push(`On branch ${this.currentBranch() || '(detached HEAD)'}`);
        if (unstaged.length) {
          lines.push('Changes not staged for commit:');
          for (const s of unstaged) lines.push(`\t${(s.kind + ':').padEnd(12)}${s.path}`);
        }
        if (untracked.length) {
          lines.push('Untracked files:');
          for (const p of untracked) lines.push(`\t${p}`);
        }
        lines.push('no changes added to commit (use "git add" and/or "git commit -a")');
      } else {
        lines.push('nothing to commit, working tree clean');
      }
      return { output: lines.join('\n'), error: true };
    }

    const parents = parent ? [parent.id] : [];
    const c = this.makeCommit(message, parents, newTree);
    const br = this.currentBranch();
    if (br) this.branches.set(br, c.id);
    else this.HEAD = { type: 'commit', id: c.id };

    const rootTag = parents.length ? '' : ' (root-commit)';
    const where = br || 'detached HEAD';
    const stat = this.statBlock(parentTree, newTree);
    this.logReflog(c.id, `commit${parents.length ? '' : ' (initial)'}: ${message}`);
    return {
      output: `[${where}${rootTag} ${short(c.id)}] ${message}\n${stat.lines.join('\n')}`,
      error: false,
    };
  }

  sortedTree(tree) {
    const out = {};
    for (const k of Object.keys(tree).sort()) out[k] = tree[k];
    return out;
  }

  decorations(id) {
    const refs = [];
    const cur = this.currentBranch();
    for (const [name, tip] of this.branches) {
      if (tip !== id) continue;
      if (name === cur) refs.unshift(`HEAD -> ${name}`);
      else refs.push(name);
    }
    if (this.HEAD.type === 'commit' && this.HEAD.id === id) refs.unshift('HEAD');
    for (const [name, tip] of this.tracking) {
      if (tip === id) refs.push(`origin/${name}`);
    }
    return refs.length ? ` (${refs.join(', ')})` : '';
  }

  cmdLog(args) {
    const oneline = args.includes('--oneline');
    const graphMode = args.includes('--graph');
    const all = args.includes('--all');
    let limit = Infinity;
    const nIdx = args.indexOf('-n');
    if (nIdx !== -1 && args[nIdx + 1]) limit = parseInt(args[nIdx + 1], 10) || Infinity;
    for (const a of args) {
      const m = a.match(/^-(\d+)$/);
      if (m) limit = parseInt(m[1], 10);
    }

    const startId = this.headCommitId();
    if (!startId && !all) {
      const br = this.currentBranch() || 'HEAD';
      return { output: `fatal: your current branch '${br}' does not have any commits yet`, error: true };
    }
    let ids;
    if (all) {
      ids = new Set();
      for (const tip of this.branches.values()) for (const a of this.ancestorsOf(tip)) ids.add(a);
      if (startId) for (const a of this.ancestorsOf(startId)) ids.add(a);
    } else {
      ids = this.ancestorsOf(startId);
    }
    const list = [...ids].map((i) => this.commits.get(i)).sort((a, b) => b.seq - a.seq).slice(0, limit);
    const lines = [];
    for (const c of list) {
      const deco = this.decorations(c.id);
      if (oneline) {
        lines.push(`${graphMode ? '* ' : ''}${short(c.id)}${deco} ${c.message}`);
      } else {
        const merge = c.parents.length > 1 ? `Merge: ${c.parents.map(short).join(' ')}\n` : '';
        lines.push(
          `${graphMode ? '* ' : ''}commit ${c.id}${deco}\n${merge}` +
          `Author: ${AUTHOR}\nDate:   ${gitDate(c.seq)}\n\n    ${c.message}\n`
        );
      }
    }
    return { output: lines.join('\n').replace(/\n$/, ''), error: false };
  }

  fileDiff(path, aText, bText) {
    if (aText === bText) return [];
    const lines = [`diff --git a/${path} b/${path}`];
    const aSha = aText == null ? '0000000' : short(makeSha(aText));
    const bSha = bText == null ? '0000000' : short(makeSha(bText));
    if (aText == null) {
      lines.push('new file mode 100644', `index 0000000..${bSha}`, '--- /dev/null', `+++ b/${path}`);
    } else if (bText == null) {
      lines.push('deleted file mode 100644', `index ${aSha}..0000000`, `--- a/${path}`, '+++ /dev/null');
    } else {
      lines.push(`index ${aSha}..${bSha} 100644`, `--- a/${path}`, `+++ b/${path}`);
    }
    lines.push(...unifiedHunks(diffLines(aText || '', bText || '')));
    return lines;
  }

  cmdDiff(args) {
    const staged = args.includes('--staged') || args.includes('--cached');
    const paths = args.filter((a) => !a.startsWith('-'));
    const head = this.headTree();
    const out = [];
    if (staged) {
      const all = [...new Set([...this.index.keys(), ...Object.keys(head)])].sort();
      for (const p of all) {
        if (paths.length && !paths.includes(p)) continue;
        const a = p in head ? head[p] : null;
        const b = this.index.has(p) ? this.index.get(p) : null;
        out.push(...this.fileDiff(p, a, b));
      }
    } else {
      const all = [...new Set([...this.index.keys(), ...this.fs.keys()])].sort();
      for (const p of all) {
        if (paths.length && !paths.includes(p)) continue;
        if (!this.index.has(p)) continue; // untracked files don't show in git diff
        const a = this.index.get(p);
        const b = this.fs.has(p) ? this.fs.get(p) : null;
        out.push(...this.fileDiff(p, a, b));
      }
    }
    return { output: out.join('\n'), error: false };
  }

  cmdBranch(args) {
    const flags = args.filter((a) => a.startsWith('-'));
    const names = args.filter((a) => !a.startsWith('-'));
    const del = flags.includes('-d') || flags.includes('--delete');
    const forceDel = flags.includes('-D');
    if (del || forceDel) {
      const name = names[0];
      if (!name) return { output: 'fatal: branch name required', error: true };
      if (!this.branches.has(name)) return { output: `error: branch '${name}' not found.`, error: true };
      if (name === this.currentBranch()) {
        return { output: `error: Cannot delete branch '${name}' checked out at '${REPO_PATH}'`, error: true };
      }
      const tip = this.branches.get(name);
      if (!forceDel && this.headCommitId() && !this.isAncestor(tip, this.headCommitId())) {
        return {
          output: `error: The branch '${name}' is not fully merged.\n` +
            `If you are sure you want to delete it, run 'git branch -D ${name}'.`,
          error: true,
        };
      }
      this.branches.delete(name);
      return { output: `Deleted branch ${name} (was ${short(tip)}).`, error: false };
    }
    if (!names.length) {
      const lines = [];
      const cur = this.currentBranch();
      if (this.HEAD.type === 'commit') lines.push(`* (HEAD detached at ${short(this.HEAD.id)})`);
      for (const name of [...this.branches.keys()].sort()) {
        lines.push(name === cur ? `* ${name}` : `  ${name}`);
      }
      return { output: lines.join('\n'), error: false };
    }
    const name = names[0];
    if (this.branches.has(name)) {
      return { output: `fatal: a branch named '${name}' already exists`, error: true };
    }
    if (!this.headCommitId()) {
      return { output: "fatal: not a valid object name: 'HEAD'", error: true };
    }
    const at = names[1] ? this.resolveRef(names[1]) : this.headCommitId();
    if (!at) {
      return { output: `fatal: not a valid object name: '${names[1] || 'HEAD'}'`, error: true };
    }
    this.branches.set(name, at);
    return { output: '', error: false };
  }

  /** Files whose local modification would be clobbered by moving to targetTree. */
  checkoutBlockers(targetTree) {
    const head = this.headTree();
    const localMods = [];
    const untrackedClobber = [];
    const paths = new Set([...Object.keys(head), ...Object.keys(targetTree), ...this.fs.keys()]);
    for (const p of paths) {
      const headC = head[p];
      const targetC = targetTree[p];
      if (headC === targetC) continue; // switching won't touch this file
      const tracked = this.index.has(p) || p in head;
      const fsC = this.fs.has(p) ? this.fs.get(p) : null;
      if (tracked) {
        const idxC = this.index.has(p) ? this.index.get(p) : null;
        const dirty = fsC !== (headC ?? null) || idxC !== (headC ?? null);
        if (dirty) localMods.push(p);
      } else if (fsC != null && targetC != null && fsC !== targetC) {
        untrackedClobber.push(p);
      }
    }
    return { localMods: localMods.sort(), untrackedClobber: untrackedClobber.sort() };
  }

  moveToTree(targetTree) {
    const head = this.headTree();
    // remove tracked files not in target
    for (const p of [...this.fs.keys()]) {
      const tracked = this.index.has(p) || p in head;
      if (tracked && !(p in targetTree)) this.fs.delete(p);
    }
    for (const [p, content] of Object.entries(targetTree)) this.fs.set(p, content);
    this.index = new Map(Object.entries(targetTree));
  }

  cmdCheckout(args, verb) {
    if (this.mergeState) {
      return { output: 'fatal: you need to resolve your current index first', error: true };
    }
    let createFlag = null;
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-b' || a === '-c') { createFlag = args[i + 1]; i++; }
      else if (a === '--') continue;
      else rest.push(a);
    }
    // `git checkout -- <file>` / `git checkout <file>` restore form
    if (verb === 'checkout' && !createFlag && rest.length === 1 &&
        (this.fs.has(rest[0]) || this.index.has(rest[0])) &&
        !this.branches.has(rest[0]) && !this.resolveRef(rest[0])) {
      return this.cmdRestore([rest[0]]);
    }

    if (createFlag) {
      if (this.branches.has(createFlag)) {
        return { output: `fatal: a branch named '${createFlag}' already exists`, error: true };
      }
      const at = rest[0] ? this.resolveRef(rest[0]) : this.headCommitId();
      if (rest[0] && !at) return { output: `fatal: not a valid object name: '${rest[0]}'`, error: true };
      if (at) this.branches.set(createFlag, at);
      const from = this.describeHeadForReflog();
      this.HEAD = { type: 'branch', ref: createFlag };
      this.logReflog(at, `checkout: moving from ${from} to ${createFlag}`);
      return { output: `Switched to a new branch '${createFlag}'`, error: false };
    }

    const target = rest.filter((a) => !a.startsWith('-'))[0];
    if (!target) return { output: 'fatal: missing branch or commit argument', error: true };

    if (this.branches.has(target)) {
      if (target === this.currentBranch()) {
        return { output: `Already on '${target}'`, error: false };
      }
      const targetTree = this.commits.get(this.branches.get(target))?.tree || {};
      const { localMods, untrackedClobber } = this.checkoutBlockers(targetTree);
      if (localMods.length) {
        return {
          output: `error: Your local changes to the following files would be overwritten by ${verb}:\n` +
            localMods.map((p) => `\t${p}`).join('\n') +
            '\nPlease commit your changes or stash them before you switch branches.\nAborting',
          error: true,
        };
      }
      if (untrackedClobber.length) {
        return {
          output: `error: The following untracked working tree files would be overwritten by ${verb}:\n` +
            untrackedClobber.map((p) => `\t${p}`).join('\n') +
            '\nPlease move or remove them before you switch branches.\nAborting',
          error: true,
        };
      }
      const from = this.describeHeadForReflog();
      this.moveToTree(targetTree);
      this.HEAD = { type: 'branch', ref: target };
      this.logReflog(this.branches.get(target), `checkout: moving from ${from} to ${target}`);
      return { output: `Switched to branch '${target}'`, error: false };
    }

    // checkout a commit → detached HEAD
    const id = this.resolveRef(target);
    if (!id) {
      const msg = verb === 'switch'
        ? `fatal: invalid reference: ${target}`
        : `error: pathspec '${target}' did not match any file(s) known to git`;
      return { output: msg, error: true };
    }
    if (verb === 'switch' && !args.includes('--detach')) {
      return {
        output: `fatal: a branch is expected, got commit '${target}'\n` +
          'hint: If you want to detach HEAD at the commit, try again with the --detach option.',
        error: true,
      };
    }
    const commit = this.commits.get(id);
    const { localMods } = this.checkoutBlockers(commit.tree);
    if (localMods.length) {
      return {
        output: 'error: Your local changes to the following files would be overwritten by checkout:\n' +
          localMods.map((p) => `\t${p}`).join('\n') +
          '\nPlease commit your changes or stash them before you switch branches.\nAborting',
        error: true,
      };
    }
    const from = this.describeHeadForReflog();
    this.moveToTree(commit.tree);
    this.HEAD = { type: 'commit', id };
    this.logReflog(id, `checkout: moving from ${from} to ${short(id)}`);
    return {
      output:
`Note: switching to '${target}'.

You are in 'detached HEAD' state. You can look around, make experimental
changes and commit them, and you can discard any commits you make in this
state without impacting any branches by switching back to a branch.

If you want to create a new branch to retain commits you create, you may
do so (now or later) by using -c with the switch command. Example:

  git switch -c <new-branch-name>

HEAD is now at ${short(id)} ${commit.message}`,
      error: false,
    };
  }

  describeHeadForReflog() {
    return this.currentBranch() || short(this.headCommitId() || 'unborn');
  }

  cmdMerge(args) {
    if (args.includes('--abort')) {
      if (!this.mergeState) return { output: 'fatal: There is no merge to abort (MERGE_HEAD missing).', error: true };
      const pre = this.mergeState.preState;
      this.fs = new Map(pre.fs);
      this.index = new Map(pre.index);
      this.mergeState = null;
      return { output: '', error: false };
    }
    if (this.mergeState) {
      return { output: 'error: Merging is not possible because you have unmerged files.\nfatal: Exiting because of an unresolved conflict.', error: true };
    }
    const name = args.filter((a) => !a.startsWith('-'))[0];
    if (!name) return { output: 'fatal: No remote for the current branch.', error: true };
    const theirId = this.resolveRef(name);
    if (!theirId) return { output: `merge: ${name} - not something we can merge`, error: true };
    const ourId = this.headCommitId();
    if (!ourId) return { output: 'fatal: no commits yet on this branch', error: true };

    const { staged, unstaged } = this.statuses();
    if (staged.length || unstaged.length) {
      const files = [...new Set([...staged.map((s) => s.path), ...unstaged.map((s) => s.path)])].sort();
      return {
        output: 'error: Your local changes to the following files would be overwritten by merge:\n' +
          files.map((p) => `\t${p}`).join('\n') +
          '\nPlease commit your changes or stash them before you merge.\nAborting',
        error: true,
      };
    }

    if (this.isAncestor(theirId, ourId)) {
      return { output: 'Already up to date.', error: false };
    }

    if (this.isAncestor(ourId, theirId)) {
      // fast-forward
      const oldTree = this.headTree();
      const newTree = this.commits.get(theirId).tree;
      this.moveToTree(newTree);
      const br = this.currentBranch();
      if (br) this.branches.set(br, theirId); else this.HEAD = { type: 'commit', id: theirId };
      const stat = this.statBlock(oldTree, newTree);
      this.logReflog(theirId, `merge ${name}: Fast-forward`);
      return {
        output: `Updating ${short(ourId)}..${short(theirId)}\nFast-forward\n${stat.lines.join('\n')}`,
        error: false,
      };
    }

    // true merge (three-way, file-level)
    const baseId = this.mergeBase(ourId, theirId);
    const base = baseId ? this.commits.get(baseId).tree : {};
    const ours = this.headTree();
    const theirs = this.commits.get(theirId).tree;
    const merged = {};
    const conflicts = [];
    const paths = [...new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])].sort();
    for (const p of paths) {
      const b = base[p], o = ours[p], t = theirs[p];
      if (o === t) { if (o != null) merged[p] = o; continue; }
      if (b === o) { if (t != null) merged[p] = t; continue; }   // only theirs changed
      if (b === t) { if (o != null) merged[p] = o; continue; }   // only ours changed
      // both changed differently → conflict
      conflicts.push(p);
      merged[p] =
        `<<<<<<< HEAD\n${(o || '').replace(/\n$/, '')}\n=======\n${(t || '').replace(/\n$/, '')}\n>>>>>>> ${name}\n`;
    }

    if (conflicts.length) {
      const preState = { fs: new Map(this.fs), index: new Map(this.index), headId: ourId };
      // working dir gets merged content incl. conflict markers; index gets clean merges only
      for (const [p, content] of Object.entries(merged)) this.fs.set(p, content);
      for (const p of Object.keys(ours)) if (!(p in merged)) this.fs.delete(p);
      this.index = new Map(Object.entries(merged));
      for (const p of conflicts) this.index.delete(p); // conflicted paths are unmerged
      this.mergeState = { mergeHead: theirId, fromName: name, conflicts: new Set(conflicts), preState };
      const lines = [];
      for (const p of conflicts) {
        lines.push(`Auto-merging ${p}`);
        lines.push(`CONFLICT (content): Merge conflict in ${p}`);
      }
      lines.push('Automatic merge failed; fix conflicts and then commit the result.');
      return { output: lines.join('\n'), error: true };
    }

    // clean merge → merge commit right away
    const oldTree = this.headTree();
    this.moveToTree(merged);
    const c = this.makeCommit(`Merge branch '${name}'`, [ourId, theirId], merged);
    const br = this.currentBranch();
    if (br) this.branches.set(br, c.id); else this.HEAD = { type: 'commit', id: c.id };
    const stat = this.statBlock(oldTree, merged);
    this.logReflog(c.id, `merge ${name}: Merge made by the 'ort' strategy.`);
    return {
      output: `Merge made by the 'ort' strategy.\n${stat.lines.join('\n')}`,
      error: false,
    };
  }

  cmdReset(args) {
    let mode = '--mixed';
    const rest = [];
    for (const a of args) {
      if (a === '--soft' || a === '--mixed' || a === '--hard') mode = a;
      else rest.push(a);
    }
    const target = rest[0] || 'HEAD';
    const id = this.resolveRef(target);
    if (!id) return { output: `fatal: ambiguous argument '${target}': unknown revision or path not in the working tree.`, error: true };
    const commit = this.commits.get(id);
    const br = this.currentBranch();
    if (br) this.branches.set(br, id); else this.HEAD = { type: 'commit', id };
    if (mode === '--mixed' || mode === '--hard') {
      this.index = new Map(Object.entries(commit.tree));
    }
    if (mode === '--hard') {
      // replace tracked working files with target tree; keep untracked
      const head = commit.tree;
      for (const p of [...this.fs.keys()]) {
        if (this.index.has(p) || p in head) this.fs.delete(p);
      }
      for (const [p, content] of Object.entries(head)) this.fs.set(p, content);
      this.logReflog(id, `reset: moving to ${target}`);
      return { output: `HEAD is now at ${short(id)} ${commit.message}`, error: false };
    }
    this.logReflog(id, `reset: moving to ${target}`);
    if (mode === '--mixed') {
      const { unstaged } = this.statuses();
      if (unstaged.length) {
        return {
          output: 'Unstaged changes after reset:\n' + unstaged.map((s) => `M\t${s.path}`).join('\n'),
          error: false,
        };
      }
    }
    return { output: '', error: false };
  }

  cmdRevert(args) {
    const target = args.filter((a) => !a.startsWith('-'))[0];
    if (!target) return { output: 'usage: git revert <commit>', error: true };
    const id = this.resolveRef(target);
    if (!id) return { output: `fatal: bad revision '${target}'`, error: true };
    const commit = this.commits.get(id);
    const parentTree = commit.parents.length ? this.commits.get(commit.parents[0]).tree : {};
    const { staged, unstaged } = this.statuses();
    if (staged.length || unstaged.length) {
      return {
        output: 'error: your local changes would be overwritten by revert.\n' +
          'hint: commit your changes or stash them to proceed.\nfatal: revert failed',
        error: true,
      };
    }
    // apply the inverse of `commit`'s changes to the current tree
    const newTree = { ...this.headTree() };
    const paths = new Set([...Object.keys(commit.tree), ...Object.keys(parentTree)]);
    for (const p of paths) {
      const before = parentTree[p];
      const after = commit.tree[p];
      if (before === after) continue;
      if (before == null) delete newTree[p];   // commit created it → remove
      else newTree[p] = before;                // commit changed/deleted it → restore
    }
    this.moveToTree(newTree);
    const msg = `Revert "${commit.message}"`;
    const c = this.makeCommit(msg, [this.headCommitId()], newTree);
    const br = this.currentBranch();
    if (br) this.branches.set(br, c.id); else this.HEAD = { type: 'commit', id: c.id };
    const stat = this.statBlock(this.commits.get(c.parents[0]).tree, newTree);
    this.logReflog(c.id, `revert: ${msg}`);
    return { output: `[${br || 'detached HEAD'} ${short(c.id)}] ${msg}\n${stat.lines.join('\n')}`, error: false };
  }

  cmdRebase(args) {
    const target = args.filter((a) => !a.startsWith('-'))[0];
    if (!target) return { output: 'usage: git rebase <branch>', error: true };
    const ontoId = this.resolveRef(target);
    if (!ontoId) return { output: `fatal: invalid upstream '${target}'`, error: true };
    const br = this.currentBranch();
    if (!br) return { output: 'fatal: cannot rebase: HEAD is detached (sandbox limitation)', error: true };
    const { staged, unstaged } = this.statuses();
    if (staged.length || unstaged.length) {
      return { output: 'error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.', error: true };
    }
    const ourId = this.headCommitId();
    if (this.isAncestor(ourId, ontoId)) {
      // fast-forward case
      this.branches.set(br, ontoId);
      this.moveToTree(this.commits.get(ontoId).tree);
      return { output: `Successfully rebased and updated refs/heads/${br}.`, error: false };
    }
    if (this.isAncestor(ontoId, ourId)) {
      return { output: `Current branch ${br} is up to date.`, error: false };
    }
    const baseId = this.mergeBase(ourId, ontoId);
    // collect linear chain base..ours (first-parent walk)
    const chain = [];
    let cur = ourId;
    while (cur && cur !== baseId) {
      const c = this.commits.get(cur);
      if (c.parents.length > 1) {
        return { output: 'fatal: this sandbox cannot rebase merge commits — try a linear branch', error: true };
      }
      chain.unshift(c);
      cur = c.parents[0] || null;
    }
    // replay each commit's delta onto the new base
    let newParent = ontoId;
    const newTree = { ...this.commits.get(ontoId).tree };
    const baseTree = baseId ? this.commits.get(baseId).tree : {};
    let prevTree = baseTree;
    for (const c of chain) {
      const paths = new Set([...Object.keys(prevTree), ...Object.keys(c.tree)]);
      for (const p of paths) {
        const before = prevTree[p], after = c.tree[p];
        if (before === after) continue;
        const ontoVal = this.commits.get(ontoId).tree[p];
        if (ontoVal != null && (p in baseTree) && baseTree[p] !== ontoVal && before === baseTree[p]) {
          return {
            output: `CONFLICT (content): Merge conflict in ${p}\n` +
              `error: could not apply ${short(c.id)}... ${c.message}\n` +
              'hint: (this sandbox aborts conflicted rebases automatically — repo unchanged)',
            error: true,
          };
        }
        if (after == null) delete newTree[p];
        else newTree[p] = after;
      }
      const replayed = this.makeCommit(c.message, [newParent], { ...newTree });
      newParent = replayed.id;
      prevTree = c.tree;
    }
    this.branches.set(br, newParent);
    this.moveToTree({ ...newTree });
    this.logReflog(newParent, `rebase (finish): returning to refs/heads/${br}`);
    return { output: `Successfully rebased and updated refs/heads/${br}.`, error: false };
  }

  cmdRemote(args) {
    if (args[0] === 'add') {
      const [, name, url] = args;
      if (!name || !url) return { output: 'usage: git remote add <name> <url>', error: true };
      if (this.remotes[name]) return { output: `error: remote ${name} already exists.`, error: true };
      this.remotes[name] = { url, branches: {} };
      return { output: '', error: false };
    }
    if (!args.length || args[0] === '-v') {
      const lines = [];
      for (const [name, r] of Object.entries(this.remotes)) {
        if (args[0] === '-v') {
          lines.push(`${name}\t${r.url} (fetch)`);
          lines.push(`${name}\t${r.url} (push)`);
        } else lines.push(name);
      }
      return { output: lines.join('\n'), error: false };
    }
    return { output: `error: unknown subcommand: ${args[0]}`, error: true };
  }

  cmdPush(args) {
    const setUpstream = args.includes('-u') || args.includes('--set-upstream');
    const rest = args.filter((a) => !a.startsWith('-'));
    const origin = this.remotes.origin;
    if (!origin) {
      return { output: 'fatal: No configured push destination.\nEither specify the URL from the command-line or configure a remote repository using\n\n    git remote add <name> <url>', error: true };
    }
    let branch;
    if (rest.length >= 2) branch = rest[1];
    else {
      branch = this.currentBranch();
      if (!branch) return { output: 'fatal: you are not currently on a branch.', error: true };
      if (!this.upstreams.has(branch) && !setUpstream) {
        return {
          output: `fatal: The current branch ${branch} has no upstream branch.\n` +
            'To push the current branch and set the remote as upstream, use\n\n' +
            `    git push --set-upstream origin ${branch}`,
          error: true,
        };
      }
    }
    if (!this.branches.has(branch)) {
      return { output: `error: src refspec ${branch} does not match any`, error: true };
    }
    const localTip = this.branches.get(branch);
    const remoteTip = origin.branches[branch];
    if (remoteTip && remoteTip === localTip) {
      return { output: 'Everything up-to-date', error: false };
    }
    if (remoteTip && !this.isAncestor(remoteTip, localTip)) {
      return {
        output:
`To ${origin.url}
 ! [rejected]        ${branch} -> ${branch} (fetch first)
error: failed to push some refs to '${origin.url}'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally. This is usually caused by another repository pushing to
hint: the same ref. If you want to integrate the remote changes, use
hint: 'git pull' before pushing again.`,
        error: true,
      };
    }
    const isNew = !remoteTip;
    origin.branches[branch] = localTip;
    this.tracking.set(branch, localTip);
    const lines = [
      'Enumerating objects: 5, done.',
      'Counting objects: 100% (5/5), done.',
      'Writing objects: 100% (3/3), 312 bytes | 312.00 KiB/s, done.',
      `To ${origin.url}`,
      isNew ? ` * [new branch]      ${branch} -> ${branch}`
            : `   ${short(remoteTip)}..${short(localTip)}  ${branch} -> ${branch}`,
    ];
    if (setUpstream || (isNew && rest.length >= 2)) {
      this.upstreams.set(branch, `origin/${branch}`);
      lines.push(`branch '${branch}' set up to track 'origin/${branch}'.`);
    }
    return { output: lines.join('\n'), error: false };
  }

  cmdFetch() {
    const origin = this.remotes.origin;
    if (!origin) return { output: "fatal: 'origin' does not appear to be a git repository", error: true };
    const lines = [];
    let any = false;
    for (const [name, tip] of Object.entries(origin.branches)) {
      const old = this.tracking.get(name);
      if (old === tip) continue;
      any = true;
      if (!old) lines.push(` * [new branch]      ${name}       -> origin/${name}`);
      else lines.push(`   ${short(old)}..${short(tip)}  ${name}       -> origin/${name}`);
      this.tracking.set(name, tip);
    }
    if (!any) return { output: '', error: false };
    return {
      output: `remote: Enumerating objects: 4, done.\nremote: Total 3 (delta 0), reused 0 (delta 0)\nFrom ${origin.url.replace(/\.git$/, '')}\n${lines.join('\n')}`,
      error: false,
    };
  }

  cmdPull(args) {
    const origin = this.remotes.origin;
    if (!origin) return { output: "fatal: 'origin' does not appear to be a git repository", error: true };
    const branch = this.currentBranch();
    if (!branch) return { output: 'fatal: you are not currently on a branch.', error: true };
    const rest = args.filter((a) => !a.startsWith('-'));
    const remoteBranch = rest.length >= 2 ? rest[1] : branch;
    if (!this.upstreams.has(branch) && rest.length < 2) {
      return {
        output: 'There is no tracking information for the current branch.\n' +
          'Please specify which branch you want to merge with.\n\n' +
          `    git pull origin ${branch}`,
        error: true,
      };
    }
    if (!(remoteBranch in origin.branches)) {
      return { output: `fatal: couldn't find remote ref ${remoteBranch}`, error: true };
    }
    const fetchRes = this.cmdFetch();
    const mergeRes = this.cmdMerge([`origin/${remoteBranch}`]);
    const parts = [fetchRes.output, mergeRes.output].filter(Boolean);
    return { output: parts.join('\n'), error: mergeRes.error };
  }

  cmdReflog() {
    if (!this.reflog.length) return { output: '', error: false };
    const lines = this.reflog.map((e, i) => `${short(e.sha)} HEAD@{${i}}: ${e.desc}`);
    return { output: lines.join('\n'), error: false };
  }

  /* --------------------------- exercise support --------------------------- */

  /**
   * Apply declarative setup operations (from content JSON) to build an
   * exercise's starting state. Runs silently.
   */
  applySetup(ops = []) {
    this.setupOps = ops;
    for (const op of ops) {
      switch (op.op) {
        case 'init': this.cmdInit(); break;
        case 'write': this.fs.set(op.path, op.content.endsWith('\n') ? op.content : op.content + '\n'); break;
        case 'add': this.cmdAdd(op.paths || ['.']); break;
        case 'commit': this.cmdCommit(['-m', op.message || 'setup commit']); break;
        case 'branch': this.cmdBranch([op.name]); break;
        case 'switch': this.cmdCheckout([op.name], 'switch'); break;
        case 'switchCreate': this.cmdCheckout(['-c', op.name], 'switch'); break;
        case 'merge': this.cmdMerge([op.name]); break;
        case 'remote': {
          const url = op.url || 'https://github.com/learner/project.git';
          this.remotes.origin = { url, branches: {} };
          if (op.push !== false && this.headCommitId()) {
            const br = this.currentBranch() || 'main';
            this.remotes.origin.branches[br] = this.branches.get(br);
            this.tracking.set(br, this.branches.get(br));
            this.upstreams.set(br, `origin/${br}`);
          }
          break;
        }
        case 'remoteCommit': {
          // A teammate pushes a commit to the simulated remote.
          const origin = this.remotes.origin;
          if (!origin) break;
          const branch = op.branch || 'main';
          const parentId = origin.branches[branch] || null;
          const parentTree = parentId ? this.commits.get(parentId).tree : {};
          const tree = { ...parentTree, [op.path]: op.content.endsWith('\n') ? op.content : op.content + '\n' };
          const seq = ++this.seq;
          const id = makeSha(`remote|${seq}|${op.message}|${JSON.stringify(tree)}`);
          this.commits.set(id, { id, parents: parentId ? [parentId] : [], message: op.message || 'Teammate commit', tree, seq, branchHint: branch });
          origin.branches[branch] = id;
          break;
        }
        default: break;
      }
    }
    this.lastCommand = null;
    this.setupSnapshot = new Map(this.fs);
  }

  /* ------------------------------ UI adapters ----------------------------- */

  /** Graph snapshot for the visualization layer. */
  getGraph() {
    const ids = new Set();
    for (const tip of this.branches.values()) for (const a of this.ancestorsOf(tip)) ids.add(a);
    const headId = this.headCommitId();
    if (headId) for (const a of this.ancestorsOf(headId)) ids.add(a);
    for (const tip of this.tracking.values()) for (const a of this.ancestorsOf(tip)) ids.add(a);
    for (const r of Object.values(this.remotes)) {
      for (const tip of Object.values(r.branches)) for (const a of this.ancestorsOf(tip)) ids.add(a);
    }
    const commits = [...ids].map((i) => this.commits.get(i)).filter(Boolean)
      .sort((a, b) => a.seq - b.seq)
      .map((c) => ({
        id: c.id, short: short(c.id), parents: c.parents,
        message: c.message, seq: c.seq, branchHint: c.branchHint,
      }));
    return {
      initialized: this.initialized,
      commits,
      branches: [...this.branches.entries()].map(([name, tip]) => ({
        name, tip, current: name === this.currentBranch(),
      })),
      remoteBranches: [...this.tracking.entries()].map(([name, tip]) => ({ name: `origin/${name}`, tip })),
      head: { detached: this.HEAD.type === 'commit', id: headId, ref: this.currentBranch() },
      merging: !!this.mergeState,
    };
  }

  /** File-state snapshot for the working/staging/repo panel. */
  getFileState() {
    const { staged, unstaged, untracked, conflicted } = this.statuses();
    const head = this.headTree();
    const stagedMap = new Map(staged.map((s) => [s.path, s.kind]));
    const unstagedMap = new Map(unstaged.map((s) => [s.path, s.kind]));
    const conflictSet = new Set(conflicted);
    const working = [];
    const fsPaths = new Set([...this.fs.keys(), ...unstagedMap.keys()]);
    for (const p of [...fsPaths].sort()) {
      let state = 'clean';
      if (conflictSet.has(p)) state = 'conflict';
      else if (untracked.includes(p)) state = 'untracked';
      else if (this.isIgnored(p)) state = 'ignored';
      else if (unstagedMap.has(p)) state = unstagedMap.get(p) === 'deleted' ? 'deleted' : 'modified';
      working.push({ path: p, state });
    }
    const index = [];
    for (const p of [...new Set([...this.index.keys(), ...stagedMap.keys()])].sort()) {
      let state = 'clean';
      if (stagedMap.has(p)) {
        const k = stagedMap.get(p);
        state = k === 'new file' ? 'added' : k;
      }
      index.push({ path: p, state });
    }
    const repo = Object.keys(head).sort().map((p) => ({ path: p, state: 'committed' }));
    return { initialized: this.initialized, working, index, repo, merging: !!this.mergeState };
  }

  /** Candidates for terminal tab-completion. */
  completions() {
    return {
      commands: ['git', 'ls', 'cat', 'echo', 'touch', 'rm', 'pwd', 'clear', 'help', 'hint'],
      gitSubcommands: ['init', 'status', 'add', 'commit', 'log', 'diff', 'branch', 'switch',
        'checkout', 'merge', 'restore', 'reset', 'revert', 'rebase', 'remote', 'push', 'pull', 'fetch', 'reflog'],
      files: [...this.fs.keys()].sort(),
      branches: [...this.branches.keys()].sort(),
    };
  }
}

export default GitEngine;
