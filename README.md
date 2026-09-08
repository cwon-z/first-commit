# First Commit — interactive Git course

A production-ready, fully static, interactive Git course for complete beginners.
Learners type real git commands into a **simulated in-browser terminal** (no real
git binary, no WASM — the repo state machine is pure JS) and watch a **live
commit-graph visualization** update after every command.

No dependencies and no build step. Accounts and course statistics are an
optional, equally dependency-free extra — the course itself still runs as plain
static files. `node_modules/` never appears.

What is left to do lives in [TODO.md](TODO.md).

## Quick start

There are two ways to run it, and the course is identical in both.

```bash
npm start                          # with accounts   → http://localhost:8000
npm run serve:static               # static only     → http://localhost:8000
npm test                           # 2,790+ assertions, zero dependencies
```

`npm start` adds optional sign-in, so progress is saved to an account and
follows a learner between devices, and gives the course owner a statistics
page. `npm run serve:static` is the plain file server: no accounts, progress
kept in each browser. Either way there is no build step and nothing to install
— the server is Node's own `http` module and nothing else.

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
- `admin.html` — course statistics, for the owner

## Architecture

```
first-commit/
├── content/course.json   # ALL course data: modules, lessons, exercises, checks
├── engine/
│   ├── git-engine.js     # simulated git state machine — pure JS, zero DOM deps
│   └── validators.js     # state-based exercise validation + the step cascade
├── server/               # OPTIONAL accounts backend — zero dependencies
│   ├── index.js          # http server: static allowlist + JSON API + CSP
│   ├── api.js            # auth / progress / account / admin routes
│   ├── auth.js           # scrypt hashing, sessions, tokens, rate limiting
│   ├── mail.js           # file + SMTP transports, and the two messages
│   ├── store.js          # one JSON document, written atomically, migrated
│   └── stats.js          # progress documents → the owner's numbers
├── ui/
│   ├── app.js            # controller: routing, exercise orchestration
│   ├── terminal.js       # terminal emulator (history, tab-completion, colorizing)
│   ├── graph.js          # SVG commit-graph renderer (the core teaching visual)
│   ├── filetree.js       # working dir / staging / HEAD file-state panel
│   ├── lesson.js         # content-block renderer (escaped, minimal inline md)
│   ├── landing.js        # renders the landing curriculum + video from course.json
│   ├── states.js         # the #/states gallery: every UI state, live
│   ├── icons.js          # the seven inline SVG marks the interface uses
│   ├── auth.js           # sign-in dialog + the top-bar account control
│   ├── admin.js          # the course-statistics page
│   └── progress.js       # ProgressStore interface ← ★ BACKEND SEAM
├── css/
│   ├── tokens.css        # design tokens, base reset, shared primitives, @font-face
│   ├── app.css           # course app — three layouts over one DOM
│   ├── landing.css       # landing page
│   └── admin.css         # course statistics
├── assets/fonts/         # self-hosted latin subsets (Archivo + JetBrains Mono)
├── tests/
│   ├── engine.test.js              # engine + validators              (246 assertions)
│   ├── content.test.js             # course.json valid AND solvable  (2262)
│   ├── ui.test.js                  # UI ↔ HTML contract, a11y         (130)
│   ├── server.test.js              # accounts, progress, stats, safety (124)
│   └── fixtures-solutions.json     # a worked solution for every challenge
├── tools/                # authoring tools, not shipped to learners
│   ├── check-module.mjs  # validate one drafted module + prove its challenge solvable
│   ├── merge-drafts.mjs  # splice drafts into course.json, refusing on any regression
│   ├── lint-course.mjs   # cross-module coherence: ordering, xrefs, vocabulary
│   └── course-to-md.mjs  # render the course as readable Markdown for proof-reading
├── index.html            # landing page
├── app.html              # course app shell
└── admin.html            # course statistics (owner only)
```

**Separation of concerns:** content is data (`/content`), the git simulation is a
pure, unit-testable library (`/engine`), and the DOM lives only in `/ui`. The
engine can be driven headlessly (that's exactly what the tests do).

**The shell has two shapes**, switched by `data-mode` on `<body>`. `read` is the
lesson reader: one centred column, no workspace. `exercise` brings up the four
regions an exercise needs, and has two layouts of its own, set by `data-layout`:

- `split` — instructions rail on the left, commit graph above the terminal on
  the right, file state as an overlay toggled from the exercise bar.
- `focus` — one panel at a time (steps / graph / files) above a pinned terminal,
  with a "now" bar naming the current step. Forced below 1000px, which is what
  makes all four regions usable on a 360px phone.

Both layouts are the same DOM; only CSS and three attributes change, so nothing
is re-rendered when the learner switches.

### The backend seam

The UI talks only to the `ProgressStore` interface in `ui/progress.js`. Two
implementations ship — `LocalStorageProgressStore` (this device) and
`RestProgressStore` (the signed-in account) — and `chooseStore()` picks one at
boot from whether there is a server and whether anyone is signed in. Nothing
above the seam knows which it got, and `tests/ui.test.js` asserts that no other
module in `ui/` so much as mentions `localStorage`.

The progress document is versioned JSON (`{version, completedLessons,
lastLessonId, updatedAt}`), which is also exactly what the API stores, so
replacing this server with a different one is a matter of matching four routes.

## Accounts

Optional, and optional all the way through: without the server the control
never appears, and with it a learner can finish the whole course as a guest.
What an account buys is progress that survives a new laptop.

```bash
npm start                                    # http://localhost:8000
PORT=3000                                    # port to listen on
FC_DATA=./data/fc.json                       # where the JSON document lives
FC_OWNER_EMAILS=you@example.com              # who owns the course
FC_BASE_URL=https://course.example.com       # public origin, for email links
FC_SMTP_URL=smtps://user:pass@smtp.host:465  # send real email
FC_MAIL_FROM=course@example.com              # envelope sender
FC_REQUIRE_VERIFICATION=1                    # unconfirmed accounts cannot save
FC_SECURE_COOKIES=1                          # behind HTTPS
```

### Set FC_OWNER_EMAILS before you deploy

Ownership is what opens `/admin.html` and everyone's progress with it.

- **With `FC_OWNER_EMAILS` set**, ownership comes from that list and nowhere
  else. Strangers who register are learners, however early they arrive.
- **Without it**, the first account to register takes ownership. That is
  convenient on a laptop and a real hole on a public host: between starting the
  server and signing up yourself, whoever finds the URL first becomes the owner.

The server prints a loud warning while an instance is unclaimed. Do not ignore
it on anything reachable from the internet.

### Opening it to people you don't know

Everything above still applies; three more things start to matter once sign-up
is public.

**Set `FC_TRUST_PROXY` to the number of reverse proxies in front of you** —
almost always `1`, because that is how you got HTTPS. Without it every request
looks like it came from the proxy, so all rate limiting collapses into one
bucket shared by the whole internet: one attacker locks out every real learner,
and the per-client protection is worth nothing.

**Sign-up sends mail to whatever address is typed**, which makes any open
course a potential machine for delivering mail to strangers from your domain.
There is a ceiling on outbound mail for the whole instance —
`FC_MAIL_MAX_PER_HOUR`, default 100 — and going over it logs loudly and drops
the message rather than sending it. Accounts are still created; mail is
best-effort and never a gate.

**Consider `FC_REQUIRE_VERIFICATION=1`.** Unconfirmed accounts can still read
the course but cannot save progress, which makes throwaway sign-ups pointless
without making the course unusable for someone who has not checked their mail
yet.

A working public configuration:

```bash
FC_OWNER_EMAILS=you@example.com \
FC_BASE_URL=https://course.example.com \
FC_TRUST_PROXY=1 \
FC_SECURE_COOKIES=1 \
FC_REQUIRE_VERIFICATION=1 \
FC_SMTP_URL=smtps://user:pass@smtp.example.com:465 \
FC_MAIL_FROM=course@example.com \
npm start
```

**How many people it holds.** Every write rewrites the whole data file, so cost
is linear in accounts. Measured, with each learner carrying progress and a live
session: 100 users → 0.9 ms per save, 1,000 → 2.5 ms, 5,000 → 10.3 ms. Writes
are serialised, so even 5,000 accounts leaves room for roughly a hundred saves a
second, far more than a course generates. Comfortable into the low thousands;
past that, `server/store.js` is the one file to replace and nothing above it
needs to change.

### Email

`FC_SMTP_URL` is the only thing standing between you and working verification
and password reset. Without it nothing is lost — messages are written to
`data/outbox/` and the link is printed to the console, which is enough to run a
course for people you know. With it, sign-up confirmation and self-service
password reset work the way people expect.

Only two messages are ever sent: confirm your address, and reset your password.

### Privacy

[PRIVACY.md](PRIVACY.md) records what is stored, for how long, who can see it,
and how to get rid of it. Learners can export everything the server holds about
them and delete their account from the account menu; the owner can reset or
delete a learner from the statistics page.

Signing in merges rather than replaces: whatever a guest finished on that device
is unioned into the account, because losing three modules of work at the moment
you sign up is how you lose the learner too.

| | |
|---|---|
| Storage | One JSON document, written atomically. `data/` is git-ignored. |
| Passwords | scrypt, per-user salt, constant-time compare. Ten characters minimum. |
| Sessions | Opaque random tokens; only their SHA-256 is stored. HttpOnly, SameSite=Lax, 30 days. |
| CSRF | SameSite plus a custom header no cross-origin form can set. |
| Guessing | Rate-limited per address *and* client, so nobody can lock a learner out on purpose. |
| Enumeration | "Wrong password" and "no such account" return the same message. |
| Served files | An allowlist. `data/`, `tests/`, `drafts/` and `server/` are not reachable over HTTP — the accounts file and the challenge solutions both live there. |
| Reset links | Single-use, one hour, and using one signs out every other device. |
| Ownership | From `FC_OWNER_EMAILS` when set; otherwise first-to-register, with a warning. |

### Course statistics — `/admin.html`

The owner's view, computed server-side from the same progress documents the
learners write, so it cannot disagree with what a learner sees:

- Learners, active this week, average completion, how many have finished.
- Per module, the share of learners who completed every unit in it.
- **Where the course loses people** — every unit in order, how many finished it,
  and the drop from the unit before. This is the one that changes what you write
  next.
- Every learner: completion, which module they are on, what they last opened,
  when they were last seen.

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

Lesson ids are permanent — they are URLs and progress-store keys, so a lesson
inserted between `m2l1` and `m2l2` is `m2l1b`, not a renumbering. Order comes
from the array, never from the id.

### Vocabulary, decided

`lint-course` reports competing words for the same idea. Some of that drift is
real and some of it is teaching, so the calls below are made and should not be
re-litigated every time the linter prints them:

| It says | The call |
|---|---|
| `repo` (81) vs `repository` (50) | **Both, deliberately.** Module 1 introduces it as *A repository ("repo")*, because "repo" is what every real conversation and every tutorial says. Refusing the shorthand would leave a beginner unable to read anything outside this course. |
| `snapshot` (33) vs `commit` | **Both, deliberately.** "Snapshot" is the metaphor that makes a commit make sense; "commit" is its name. The course teaches the first and then uses the second. |
| `save point` (2) | Kept. It appears once, introducing the video-game analogy in module 1, and is never used as a bare synonym. |
| `the stage` (1) | A false positive — it is matching *"the staged file"*. |
| `working tree` (7) | Kept where it quotes real `git status` output, which says "working tree clean". Changing it would make the course disagree with the terminal. |
| `your folder` (4) | Kept only where it is deliberately plain language for a beginner. Where the precise idea was being taught, it now says **working directory**. |

The rule behind all of these: precise terms where the learner needs to recognise
them later, plain words where they only need to understand the idea now.

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

- **server.test.js** boots the real server against a scratch file and talks to
  it over HTTP. It asserts the things that are silent when they break: that a
  near-miss password fails, that sign-out really ends the session, that one
  learner cannot read or overwrite another's progress, that a learner cannot
  open the statistics, and that the accounts file and the challenge solutions
  are not reachable over HTTP.

CI runs all four on Node 18, 20 and 22 (`.github/workflows/test.yml`).

## Accessibility

Keyboard focus is visible everywhere (`:focus-visible`), the sidebar closes on
`Escape` and reports state via `aria-expanded`, the active lesson is marked
`aria-current`, and the commit graph — the course's core visual — is narrated
into an `aria-live` region that updates after every command. All animation and
programmatic scrolling backs off under `prefers-reduced-motion`.

Colour is never the only carrier of meaning. Terminal output prints a glyph in a
fixed gutter (`›` command, `!` error, `+` addition, `−` deletion) as well as
colouring the line; file rows carry a glyph and the state spelled out; and a
challenge condition says `met` or `waiting` next to its filled or hollow disc.

## Deployment notes

- 100% static output — no bundler, no framework, no CDN dependencies, no
  absolute paths (safe behind any reverse proxy / subpath). The accounts backend
  is optional and equally dependency-free; without it the course is unchanged.
- ES modules require a normal web server (see Quick start).
- Type is self-hosted from `assets/fonts/` — the latin subsets of Archivo
  (one variable file, 200–700) and JetBrains Mono at 400/500, ~115 KB in all.
  Nothing is fetched from Google Fonts or anywhere else.
- The YouTube embed appears automatically once `meta.youtubeVideoId` is set in
  `content/course.json` — there is no HTML to edit.

## License

MIT — see [LICENSE](LICENSE).
