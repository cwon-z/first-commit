/* ============================================================================
 * first-commit — exercise validators
 * ----------------------------------------------------------------------------
 * Pure JS, no DOM. Validates exercise completion by inspecting the RESULTING
 * REPO STATE — never by string-matching the commands the learner typed.
 *
 * (One pragmatic exception: the `commandRan` check, used only in guided
 * walkthroughs for read-only commands like `ls` or `git status` that change
 * no state. It matches the parsed command *semantically* — name, subcommand,
 * success, and where the step is about one particular variant, the flag that
 * makes it that variant — not the raw string. Challenge exercises never use
 * it.)
 *
 * Each check in content JSON looks like:
 *   { "kind": "fileCommitted", "path": "notes.txt", "label": "notes.txt is committed" }
 * ========================================================================== */

/**
 * The commit a check is about. `nth` counts forward from the first commit on
 * the branch (1 = the root), following first parents; `ref` counts back from
 * wherever HEAD is. Prefer `nth` when the checklist names commits in the order
 * the learner makes them: "first new commit: only app.js" should tick the
 * moment that commit exists and stay ticked, and a `ref` of HEAD~1 cannot do
 * that — it points at a different commit after every new one.
 */
function commitFor(engine, check) {
  if (check.nth != null) {
    let id = check.branch ? engine.branches.get(check.branch) : engine.headCommitId();
    const chain = [];
    while (id) {
      chain.push(id);
      const c = engine.commits.get(id);
      id = c && c.parents.length ? c.parents[0] : null;
    }
    return chain[chain.length - check.nth] || null;
  }
  return engine.resolveRef(check.ref || 'HEAD');
}

/** The paths a commit changed relative to its first parent, or null. */
function changedPaths(engine, id) {
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

  conflictResolved: (e, c) => {
    // The path is no longer in dispute: not listed as unmerged, and no marker
    // lines left in it. Use this — not fileStaged — for "you ran git add on the
    // conflicted file": keeping your own side is a legitimate resolution, and
    // then the index equals HEAD, so nothing about the file ever looks staged.
    if (e.mergeState && e.mergeState.conflicts.has(c.path)) return false;
    const content = e.fs.get(c.path);
    return content != null && !/^(<{7}|={7}|>{7})/m.test(content);
  },

  notMerging: (e) => !e.mergeState,

  /* --- history shape --- */
  lastCommitMessage: (e, c) => {
    // The newest commit's message — or, with `nth` / `ref`, that commit's.
    // minLength / maxLength measure the subject line, so a body is welcome.
    const id = c.nth != null || c.ref != null ? commitFor(e, c) : e.headCommitId();
    const commit = id ? e.commits.get(id) : null;
    if (!commit) return false;
    const subject = commit.message.split('\n')[0].trim();
    if (c.equals != null && commit.message !== c.equals) return false;
    if (c.contains != null) {
      const hay = c.ci ? commit.message.toLowerCase() : commit.message;
      if (!hay.includes(c.ci ? c.contains.toLowerCase() : c.contains)) return false;
    }
    if (c.minLength != null && subject.length < c.minLength) return false;
    if (c.maxLength != null && subject.length > c.maxLength) return false;
    return true;
  },

  commitTouched: (e, c) => {
    // The commit at `nth` / `ref` changed exactly / at least the given paths.
    const changed = changedPaths(e, commitFor(e, c));
    if (!changed) return false;
    const want = new Set(c.paths || [c.path]);
    for (const p of want) if (!changed.has(p)) return false;
    if (c.exact) {
      for (const p of changed) if (!want.has(p)) return false;
    }
    return true;
  },

  commitOnBranch: (e, c) => {
    // The commit that first added `path` was made while standing on `branch`.
    // The end state cannot show this — a branch created after the fact points
    // at the same commit — so it reads what the commit itself recorded.
    const tip = c.into ? e.branches.get(c.into) : e.headCommitId();
    if (!tip) return false;
    const adders = [...e.ancestorsOf(tip)].map((id) => e.commits.get(id)).filter((k) => {
      if (!k || !(c.path in k.tree)) return false;
      return !k.parents.some((p) => c.path in e.commits.get(p).tree);
    }).sort((a, b) => a.seq - b.seq);
    return adders.length > 0 && adders[0].branchHint === c.branch;
  },

  pathIgnored: (e, c) => {
    // The .gitignore rules in force would cover this path — which need not
    // exist. Asking about `tomorrow.log` is how "every .log file" is told
    // apart from two log files listed by name.
    return typeof e.matchesIgnore === 'function' && e.matchesIgnore(c.path);
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
    // `sub` may list alternatives (switch / checkout). `withArg` names flags or
    // arguments, any one of which must be present — `git diff` and
    // `git diff --staged` answer different questions, and a step about the
    // second should not be passed by the first. `failed: true` is for the rare
    // step whose command is meant to be refused.
    const last = e.lastCommand;
    if (!last || (c.failed ? last.ok : !last.ok)) return false;
    if (c.command && last.name !== c.command) return false;
    if (c.sub && !(Array.isArray(c.sub) ? c.sub : [c.sub]).includes(last.sub)) return false;
    if (c.withArg && !c.withArg.some((a) => (last.args || []).includes(a))) return false;
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

/**
 * Advance a guided walkthrough after a command has run. Returns the new step
 * index (unchanged if nothing was satisfied).
 *
 * One command can legitimately satisfy several consecutive steps — `git commit
 * -am` covers both a "stage it" and a "commit it" step — so this keeps walking
 * while the state checks pass. The exception is `commandRan`: that check
 * inspects the single command sitting in `engine.lastCommand`, so once that
 * command has been consumed to advance one step it must not tick off the next
 * one too, or a lone `git status` would complete every read-only step at once.
 *
 * @param {object} engine   GitEngine instance
 * @param {Array}  steps    exercise.steps from course.json
 * @param {number} stepIdx  the learner's current step
 * @returns {number} the step index after this command
 */
export function advanceSteps(engine, steps = [], stepIdx = 0) {
  let idx = stepIdx;
  let advanced = false;
  while (idx < steps.length) {
    const step = steps[idx];
    if (advanced && (step.expect || []).some((c) => c.kind === 'commandRan')) break;
    if (!allPassed(runChecks(engine, step.expect))) break;
    idx++;
    advanced = true;
  }
  return idx;
}

export default { CHECKS, runChecks, allPassed, advanceSteps };
