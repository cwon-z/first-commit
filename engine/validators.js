/* ============================================================================
 * first-commit — exercise validators
 * ----------------------------------------------------------------------------
 * Pure JS, no DOM. Validates exercise completion by inspecting the RESULTING
 * REPO STATE — never by string-matching the commands the learner typed.
 *
 * (One pragmatic exception: the `commandRan` check, used only in guided
 * walkthroughs for read-only commands like `ls` or `git status` that change
 * no state. It matches the parsed command *semantically* — name + subcommand
 * + success — not the raw string. Challenge exercises never use it.)
 *
 * Each check in content JSON looks like:
 *   { "kind": "fileCommitted", "path": "notes.txt", "label": "notes.txt is committed" }
 * ========================================================================== */

/** Returns true iff `commit` changed exactly (or at least) the given paths. */
function changedPaths(engine, ref) {
  const id = engine.resolveRef(ref);
  if (!id) return null;
  const c = engine.commits.get(id);
  const parentTree = c.parents.length ? engine.commits.get(c.parents[0]).tree : {};
  const changed = new Set();
  for (const p of new Set([...Object.keys(c.tree), ...Object.keys(parentTree)])) {
    if (c.tree[p] !== parentTree[p]) changed.add(p);
  }
  return changed;
}

function contentMatches(content, check) {
  if (content == null) return false;
  if (check.equals != null) return content.replace(/\n$/, '') === check.equals.replace(/\n$/, '');
  if (check.contains != null) {
    const hay = check.ci ? content.toLowerCase() : content;
    const needle = check.ci ? check.contains.toLowerCase() : check.contains;
    return hay.includes(needle);
  }
  if (check.nonEmpty) return content.trim().length > 0;
  return true;
}

export const CHECKS = {
  /* --- repo shape --- */
  repoInitialized: (e) => e.initialized,

  commitCount: (e, c) => {
    const tip = c.branch ? e.branches.get(c.branch) : e.headCommitId();
    if (!tip) return (c.min || 0) === 0;
    const n = e.ancestorsOf(tip).size;
    if (c.min != null && n < c.min) return false;
    if (c.max != null && n > c.max) return false;
    if (c.exact != null && n !== c.exact) return false;
    return true;
  },

  branchExists: (e, c) => e.branches.has(c.name),
  branchAbsent: (e, c) => !e.branches.has(c.name),
  headOnBranch: (e, c) => e.initialized && e.currentBranch() === c.name,
  headDetached: (e) => e.HEAD.type === 'commit',

  /* --- files in the three areas --- */
  fileExists: (e, c) => e.fs.has(c.path) && contentMatches(e.fs.get(c.path), c),
  fileAbsent: (e, c) => !e.fs.has(c.path),

  fileStaged: (e, c) => {
    // staged = the index version of this path differs from HEAD's version
    const head = e.headTree();
    const idx = e.index.has(c.path) ? e.index.get(c.path) : null;
    const h = c.path in head ? head[c.path] : null;
    if (idx == null && h == null) return false;
    return idx !== h && (c.content == null || contentMatches(idx, c));
  },

  fileNotStaged: (e, c) => {
    // index entry for path matches HEAD (nothing staged for this file)
    const head = e.headTree();
    const idx = e.index.has(c.path) ? e.index.get(c.path) : null;
    const h = c.path in head ? head[c.path] : null;
    return idx === h;
  },

  fileCommitted: (e, c) => {
    const ref = c.ref || (c.branch || 'HEAD');
    const id = e.resolveRef(ref === 'HEAD' ? 'HEAD' : ref);
    if (!id) return false;
    const tree = e.commits.get(id).tree;
    return c.path in tree && contentMatches(tree[c.path], c);
  },

  fileChanged: (e, c) => {
    // working-dir content differs from the exercise's starting snapshot
    if (!e.setupSnapshot) return false;
    const before = e.setupSnapshot.has(c.path) ? e.setupSnapshot.get(c.path) : null;
    const now = e.fs.has(c.path) ? e.fs.get(c.path) : null;
    return before !== now;
  },

  cleanWorkingTree: (e, c) => {
    if (!e.initialized) return false;
    const { staged, unstaged, untracked, conflicted } = e.statuses();
    if (staged.length || unstaged.length || conflicted.length) return false;
    if (c && c.allowUntracked === false && untracked.length) return false;
    return true;
  },

  noConflictMarkers: (e, c) => {
    const content = e.fs.get(c.path);
    if (content == null) return false;
    return !/^(<{7}|={7}|>{7})/m.test(content);
  },

  notMerging: (e) => !e.mergeState,

  /* --- history shape --- */
  lastCommitMessage: (e, c) => {
    const commit = e.headCommit();
    if (!commit) return false;
    if (c.equals != null) return commit.message === c.equals;
    if (c.contains != null) {
      const hay = c.ci ? commit.message.toLowerCase() : commit.message;
      return hay.includes(c.ci ? c.contains.toLowerCase() : c.contains);
    }
    if (c.minLength != null) return commit.message.trim().length >= c.minLength;
    return true;
  },

  commitTouched: (e, c) => {
    // The commit at `ref` changed exactly / at least the given paths.
    const changed = changedPaths(e, c.ref || 'HEAD');
    if (!changed) return false;
    const want = new Set(c.paths || [c.path]);
    for (const p of want) if (!changed.has(p)) return false;
    if (c.exact) {
      for (const p of changed) if (!want.has(p)) return false;
    }
    return true;
  },

  mergeCommitAt: (e, c) => {
    const tip = c.branch ? e.branches.get(c.branch) : e.headCommitId();
    if (!tip) return false;
    return e.commits.get(tip).parents.length >= 2;
  },

  branchesMerged: (e, c) => {
    // tip of `from` is reachable from tip of `into`
    const fromTip = e.branches.get(c.from) || e.resolveRef(c.from);
    const intoTip = e.branches.get(c.into) || e.resolveRef(c.into);
    if (!fromTip || !intoTip) return false;
    return e.isAncestor(fromTip, intoTip);
  },

  /* --- remote --- */
  remoteUpToDate: (e, c) => {
    const branch = c.branch || 'main';
    const origin = e.remotes.origin;
    if (!origin) return false;
    return origin.branches[branch] != null && origin.branches[branch] === e.branches.get(branch);
  },

  pulledRemote: (e, c) => {
    // local branch contains the remote tip (after a pull/fetch+merge)
    const branch = c.branch || 'main';
    const origin = e.remotes.origin;
    if (!origin || !origin.branches[branch]) return false;
    const local = e.branches.get(branch);
    if (!local) return false;
    return e.isAncestor(origin.branches[branch], local);
  },

  /* --- guided-walkthrough only (semantic, not string-matching) --- */
  commandRan: (e, c) => {
    const last = e.lastCommand;
    if (!last || !last.ok) return false;
    if (c.command && last.name !== c.command) return false;
    if (c.sub && last.sub !== c.sub) return false;
    return true;
  },
};

/**
 * Evaluate a list of checks against an engine.
 * Returns [{ check, passed, label }].
 */
export function runChecks(engine, checks = []) {
  return checks.map((check) => {
    const fn = CHECKS[check.kind];
    let passed = false;
    try {
      passed = fn ? !!fn(engine, check) : false;
    } catch {
      passed = false;
    }
    return { check, passed, label: check.label || check.kind };
  });
}

export function allPassed(results) {
  return results.length > 0 && results.every((r) => r.passed);
}

export default { CHECKS, runChecks, allPassed };
