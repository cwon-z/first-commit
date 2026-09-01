# First Commit — interactive Git course

A production-ready, fully static, interactive Git course for complete beginners.
Learners type real git commands into a **simulated in-browser terminal** (no real
git binary, no WASM — the repo state machine is pure JS) and watch a **live
commit-graph visualization** update after every command.

No dependencies, no build step, no backend. `node_modules/` never appears.

## Quick start

Any static file server works.

```bash
# from this folder:
python3 -m http.server 8000        # then open http://localhost:8000
npm run serve                      # same thing
npm test                           # 2,400+ assertions, zero dependencies
```

Caddy:

```caddyfile
yourdomain.com {
    root * /path/to/first-commit
    file_server
}
```

> Note: the app loads `content/course.json` via `fetch()`, so it must be served
> over http(s) — opening `index.html` via `file://` will not work.

- `index.html` — public landing page (hero, curriculum, YouTube embed slot)
- `app.html` — the course application

## Architecture

```
first-commit/
├── content/course.json   # ALL course data: modules, lessons, exercises, checks
├── engine/
│   ├── git-engine.js     # simulated git state machine — pure JS, zero DOM deps
│   └── validators.js     # state-based exercise validation + the step cascade
├── ui/
│   ├── app.js            # controller: routing, exercise orchestration
│   ├── terminal.js       # terminal emulator (history, tab-completion, colorizing)
│   ├── graph.js          # SVG commit-graph renderer (the core teaching visual)
│   ├── filetree.js       # working dir / staging / HEAD file-state panel
│   ├── lesson.js         # content-block renderer (escaped, minimal inline md)
│   ├── landing.js        # renders the landing curriculum + video from course.json
│   └── progress.js       # ProgressStore interface ← ★ BACKEND SEAM
├── css/                  # app.css (course app) + landing.css (landing page)
├── tests/
│   ├── engine.test.js              # engine + validators              (246 assertions)
│   ├── content.test.js             # course.json valid AND solvable  (2204)
│   ├── ui.test.js                  # UI ↔ HTML contract, a11y          (64)
│   └── fixtures-solutions.json     # a worked solution for every challenge
├── tools/                # authoring tools, not shipped to learners
│   ├── check-module.mjs  # validate one drafted module + prove its challenge solvable
│   ├── merge-drafts.mjs  # splice drafts into course.json, refusing on any regression
│   ├── lint-course.mjs   # cross-module coherence: ordering, xrefs, vocabulary
│   └── course-to-md.mjs  # render the course as readable Markdown for proof-reading
├── index.html            # landing page
└── app.html              # course app shell
```

**Separation of concerns:** content is data (`/content`), the git simulation is a
pure, unit-testable library (`/engine`), and the DOM lives only in `/ui`. The
engine can be driven headlessly (that's exactly what the tests do).

### The backend seam

v1 stores progress in `localStorage`. The UI talks only to the `ProgressStore`
interface in `ui/progress.js`; the swap point is one line at the top of
`ui/app.js`:

```js
const store = new LocalStorageProgressStore();
// later: const store = new RestProgressStore('https://api.example.com', token);
```

The progress document is versioned JSON (`{version, completedLessons,
lastLessonId, updatedAt}`) so a future backend can migrate cleanly. Nothing else
in the UI knows where progress lives.

## The simulated git engine

`engine/git-engine.js` models: a fake flat filesystem, the index/staging area,
commits as an immutable DAG, branches as pointers, HEAD (attached or detached),
merge state (incl. conflict markers + MERGE_HEAD semantics), simulated remotes
with per-remote tracking refs and upstreams, a stash, and a reflog.

Supported commands: `init · status · add [-f] · restore [--staged] · commit
[-m|-a|-am|--amend] · log [--oneline|-n] · diff [--staged|<ref>|<refA> <refB>] ·
show [<ref>] · branch [-d|-D] · switch [-c|--detach] · checkout [-b|--|<commit>] ·
merge [--abort] · reset [--soft|--mixed|--hard] · revert · rebase ·
stash [push|pop|apply|list|drop|clear] · remote [add|-v] · push [-u] · fetch ·
pull · reflog`, plus shell basics
(`ls · cat · echo >/>> · touch · rm · pwd · clear`) and `.gitignore` patterns.

Output format and error messages mirror real git (root-commit lines, diffstat,
"Your local changes … would be overwritten", detached-HEAD advice, non-fast-forward
push rejection with the `fetch first` hint, etc.) so learners transfer cleanly
to the real tool. Where the sandbox genuinely can't do something — `git clone`
has no network to reach — it says so and points at what to do instead, rather
than pretending the command doesn't exist.

**Sandbox limitations** (deliberate, and worth knowing before you write a lesson):
the filesystem is flat-ish — paths with `/` work, but there is no `mkdir` or
`cd`; `rebase` handles linear branches only and aborts on conflict; `stash pop`
restores its snapshot wholesale rather than three-way merging it; `.gitignore`
supports `name`, `*.ext` and `dir/` patterns, not negation or globstars.

**Validation is state-based.** Exercises pass when the *resulting repo state*
matches declarative checks (`fileCommitted`, `commitTouched {exact}`,
`mergeCommitAt`, `remoteUpToDate`, …) — never by matching typed command strings.
The one pragmatic exception is `commandRan` (semantic: parsed command + success),
used only for read-only steps like `git status` in guided walkthroughs. The
content test enforces that challenges never use it.

## Authoring content

Everything lives in `content/course.json`. A lesson is `concept`, `guided`, or
`challenge`; modules also get a `recap`. Useful pieces:

- **Body blocks:** `{"p": …}`, `{"h": …}`, `{"list": […]}`, `{"code": …}`,
  `{"analogy": …}`, `{"tip": …}`, `{"warn": …}`, and `{"graph": {"ops": […],
  "caption": …}}` — graph blocks are rendered by running the ops through a
  throwaway engine and drawing the result, so diagrams can never drift from
  engine behavior. The recognised keys are exported as `BLOCK_KINDS` from
  `ui/lesson.js`; an unrecognised block warns in the console and fails the tests.
- **Exercise setup ops:** `init`, `write`, `add`, `commit`, `branch`, `switch`,
  `switchCreate`, `merge`, `remote`, `remoteCommit` (simulates a teammate
  pushing — used to teach pull/rejected-push). The list is exported as
  `SETUP_OPS` from `engine/git-engine.js`; a typo'd op is reported in
  `engine.setupWarnings` instead of being silently skipped.
- **Checks:** see `engine/validators.js` for the full catalog; every check takes
  a human-readable `label` shown in the live goal checklist.

### The curriculum

All 11 modules ship: 34 lessons (12 concept, 11 guided, 11 challenge) plus 11
module recaps, 472 content blocks and 32 live commit-graph diagrams.

| # | Module | Teaches |
|---|--------|---------|
| 1 | Why Git Exists | version control from first principles; snapshots, not diffs |
| 2 | Your First Repository | `init`, `status`, `add`, `commit -m` |
| 3 | Staging vs Committing | the three areas; crafting precise commits; `restore --staged` |
| 4 | Status & Diff | reading `status`; the unified diff format; `diff --staged`, `diff <ref>`, `show` |
| 5 | Branching | a branch is a pointer; `switch -c`, `switch`, `branch -d`; HEAD |
| 6 | Merging & Conflicts | fast-forward vs three-way; conflict markers; `merge --abort` |
| 7 | Remotes & Push/Pull | `origin/main` as cached memory; `push -u`, `fetch` vs `pull`; rejected pushes |
| 8 | Collaboration Basics | the feature-branch loop end to end; pull requests conceptually |
| 9 | Undoing Mistakes | `reset` soft/mixed/hard, `revert`, `stash`, `--amend`, `reflog` |
| 10 | .gitignore | ignore patterns; what belongs in a repo; `add -f`; committed secrets |
| 11 | Commit Hygiene | message anatomy; atomic commits; history as communication |

### Adding or changing a module

Author into `drafts/module-<N>.json` — `{"module": {...}, "solutions": {...}}`,
where `solutions` maps each challenge lesson id to the commands that solve it —
then:

```bash
node tools/check-module.mjs drafts/module-5.json --verbose   # iterate until "ready to merge"
node tools/merge-drafts.mjs                                  # dry run
node tools/merge-drafts.mjs --write                          # splice into content/course.json
```

`check-module` splices your module into the real course, runs the full content
test, replays every guided walkthrough, and replays your challenge solutions —
printing the exact check that missed and the terminal transcript when something
fails. `merge-drafts` refuses to write if any module regresses, if lesson ids
changed (they are URLs and progress-store keys), or if a module nobody drafted
was modified.

Nothing else needs touching: the landing-page curriculum and the in-app sidebar
both render from `course.json`.

`npm test` enforces this authoring contract:

- lesson ids are unique, routable, and don't collide with the generated
  `<module>-recap` ids or the `playground` route;
- a module's `status` and its lessons' `comingSoon` flags agree;
- every body block, setup op and check kind is one the code implements, and
  every check carries a `label`;
- **no exercise is already solved by its own setup** (a challenge that passes
  before the learner types anything, or a guided step that opens pre-ticked);
- **every guided walkthrough completes when you type exactly the commands it
  displays** — each step's `cmd` is replayed through the same `advanceSteps`
  cascade the browser runs, so a step whose instructions don't actually satisfy
  its own checks fails CI.

That last one is why every guided step must carry a `cmd`. If a step needs two
commands, put both in it separated by a newline — the panel renders them as a
block and the test replays them in order.

## Testing

```bash
npm test              # everything below, in order
npm run test:engine   # engine + validators
npm run test:content  # course.json validity, completability, solvability
npm run test:ui       # UI ↔ HTML contract and a11y guarantees
npm run lint:course   # cross-module coherence report (full detail)
```

- **engine.test.js** covers init/add/commit/status flows, diff (`--staged`,
  `<ref>`, and `<refA> <refB>`), `git show`, unstaging, branching,
  fast-forward + three-way merges, conflict → resolve →
  merge-commit, `merge --abort`, blocked checkouts, detached HEAD, reset
  (soft/mixed/hard), revert, rebase, `commit --amend`, `stash`, `add -f` vs
  `.gitignore`, push/reject/pull cycles across multiple remotes, reflog, all
  validators, the guided-step cascade, and the UI adapter snapshots.
- **content.test.js** validates and *executes* `content/course.json` (above) —
  the bulk of the suite, because every lesson, block, check and walkthrough in
  all 11 modules is verified individually. It also replays a worked solution for
  **every** challenge from `tests/fixtures-solutions.json` and requires the
  checks to go green, so a challenge can never be stated in a way nothing
  satisfies. Add a module, add its solution there too.
- **lint-course.mjs** catches what only shows up reading all 11 modules
  together: an exercise running a command no earlier lesson introduced, a
  cross-module reference pointing at a module that doesn't exist, a sandbox-only
  command quoted as if real. Those are hard errors and fail CI. It also reports
  vocabulary drift, duplicated sentences and length outliers for a human to
  judge — those never fail the build.
- **ui.test.js** asserts every `$('#id')` in `ui/` resolves to an element the
  HTML defines or the app creates, that both shells load their modules over
  relative paths, and that the accessibility guarantees (focus ring, `.sr-only`,
  reduced-motion block, the graph's live region) are still in place.

CI runs all three on Node 18, 20 and 22 (`.github/workflows/test.yml`).

## Accessibility

Keyboard focus is visible everywhere (`:focus-visible`), the sidebar closes on
`Escape` and reports state via `aria-expanded`, the active lesson is marked
`aria-current`, and the commit graph — the course's core visual — is narrated
into an `aria-live` region that updates after every command. All animation and
programmatic scrolling backs off under `prefers-reduced-motion`.

## Deployment notes

- 100% static output — no bundler, no framework, no runtime backend, no CDN
  dependencies, no absolute paths (safe behind any reverse proxy / subpath).
- ES modules require a normal web server (see Quick start).
- The YouTube embed appears automatically once `meta.youtubeVideoId` is set in
  `content/course.json` — there is no HTML to edit.

## License

MIT — see [LICENSE](LICENSE).
