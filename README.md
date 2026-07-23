# First Commit — interactive Git course

A production-ready, fully static, interactive Git course for complete beginners.
Learners type real git commands into a **simulated in-browser terminal** (no real
git binary, no WASM — the repo state machine is pure JS) and watch a **live
commit-graph visualization** update after every command.

## Quick start

Any static file server works — there is no build step and no backend.

```bash
# from this folder:
python3 -m http.server 8000        # then open http://localhost:8000
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
│   └── validators.js     # state-based exercise validation (never string-matching)
├── ui/
│   ├── app.js            # controller: routing, exercise orchestration
│   ├── terminal.js       # terminal emulator (history, tab-completion, colorizing)
│   ├── graph.js          # SVG commit-graph renderer (the core teaching visual)
│   ├── filetree.js       # working dir / staging / HEAD file-state panel
│   ├── lesson.js         # content-block renderer (escaped, minimal inline md)
│   └── progress.js       # ProgressStore interface ← ★ BACKEND SEAM
├── css/                  # app.css (course app) + landing.css (landing page)
├── tests/engine.test.js  # node tests/engine.test.js  (132 assertions)
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
merge state (incl. conflict markers + MERGE_HEAD semantics), a simulated
`origin` remote with remote-tracking refs and upstreams, and a reflog.

Supported commands: `init · status · add · restore [--staged] · commit [-m|-a|-am]
· log [--oneline|-n] · diff [--staged] · branch [-d|-D] · switch [-c|--detach] ·
checkout [-b|--|<commit>] · merge [--abort] · reset [--soft|--mixed|--hard] ·
revert · rebase · remote [add|-v] · push [-u] · fetch · pull · reflog`, plus
shell basics (`ls · cat · echo >/>> · touch · rm · pwd · clear`) and `.gitignore`
patterns.

Output format and error messages mirror real git (root-commit lines, diffstat,
"Your local changes … would be overwritten", detached-HEAD advice, non-fast-forward
push rejection with the `fetch first` hint, etc.) so learners transfer cleanly
to the real tool.

**Validation is state-based.** Exercises pass when the *resulting repo state*
matches declarative checks (`fileCommitted`, `commitTouched {exact}`,
`mergeCommitAt`, `remoteUpToDate`, …) — never by matching typed command strings.
The one pragmatic exception is `commandRan` (semantic: parsed command + success),
used only for read-only steps like `git status` in guided walkthroughs.

## Authoring content

Everything lives in `content/course.json`. A lesson is `concept`, `guided`, or
`challenge`; modules also get a `recap`. Useful pieces:

- **Body blocks:** `{"p": …}`, `{"h": …}`, `{"list": […]}`, `{"code": …}`,
  `{"analogy": …}`, `{"tip": …}`, `{"warn": …}`, and `{"graph": {"ops": […],
  "caption": …}}` — graph blocks are rendered by running the ops through a
  throwaway engine and drawing the result, so diagrams can never drift from
  engine behavior.
- **Exercise setup ops:** `init`, `write`, `add`, `commit`, `branch`, `switch`,
  `switchCreate`, `merge`, `remote`, `remoteCommit` (simulates a teammate
  pushing — used to teach pull/rejected-push).
- **Checks:** see `engine/validators.js` for the full catalog; every check takes
  a human-readable `label` shown in the live goal checklist.

Modules 1–3 are fully populated; modules 4–11 are scaffolded (`"status":
"coming-soon"`) — fill in their `lessons` the same way and they go live, the
engine already supports all the commands they need.

## Testing

```bash
node tests/engine.test.js
```

Covers: init/add/commit/status flows, diff + `--staged`, unstaging, branching,
fast-forward + three-way merges, conflict → resolve → merge-commit, `merge
--abort`, blocked checkouts, detached HEAD, reset (soft/mixed/hard), revert,
rebase, push/reject/pull cycles, reflog, `.gitignore`, all validators, and the
UI adapter snapshots.

## Deployment notes

- 100% static output — no bundler, no framework, no runtime backend, no CDN
  dependencies, no absolute paths (safe behind any reverse proxy / subpath).
- ES modules require a normal web server (see Quick start).
- The YouTube embed slot is marked in `index.html` (`VIDEO_ID`).
