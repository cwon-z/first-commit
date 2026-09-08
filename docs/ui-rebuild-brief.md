# First Commit — UI rebuild brief

First Commit teaches Git to complete beginners. They type real commands into a
simulated terminal and watch a commit graph redraw after every one. The engine,
the content and the tests are finished and staying — this brief covers the
interface around them.

| | |
|---|---|
| Repo | `cwon-z/first-commit` (private) |
| Scope | Presentation layer only |
| Stack | Static HTML / CSS / ES modules |
| Dependencies | None |

---

## 1. How to read this

Every requirement carries an ID so it can be referenced back ("R23 doesn't work,
here's why"), and a status label. The labels are the point of the document.

- **LOCKED** — a contract with code that is not being rebuilt. Break it and the
  app stops working, usually silently. Change these only by agreement, because
  the corresponding JavaScript has to change with them.
- **OPEN** — entirely the designer's call. Layout, colour, type, motion,
  density, component shapes. Art direction is supplied separately; nothing here
  should be read as a visual preference.
- **CONTEXT** — not a rule. Background on why something exists, so it can be
  redesigned knowingly rather than preserved by accident.

---

## 2. What the product is

A free, static, single-player web course. No accounts, no backend, no network
calls. A learner works through 11 modules in order; each module is a concept
lesson, a guided walkthrough, a challenge, and a recap.

The teaching mechanism is *simultaneity*: the learner types a real Git command
and three panels react at once — the terminal prints Git's actual output, the
commit graph redraws, and the file-state panel shows files moving between the
working directory, the staging area and the repository. Branches and commits are
invisible in real Git; making them visible is the entire pedagogical bet.

> **The single most important design problem.** Those three panels plus the
> lesson text plus the exercise instructions all compete for one screen. The
> current build shows them all at once and everything is cramped. How that
> competition is resolved — tabs, panes, progressive disclosure, a different
> spatial model entirely — is the core of this project and is completely open.

---

## 3. Scope

### In scope — rebuild freely

- `index.html` — the public landing page
- `app.html` — the course application shell
- `css/app.css` and `css/landing.css` — replace entirely
- The DOM that `ui/*.js` builds: nav items, guided steps, challenge checklists,
  hint blocks, file rows, terminal lines, graph SVG. Markup and classes are
  free; the module boundaries and the element IDs are not (see §7).

### Out of scope — do not modify

- `engine/git-engine.js` — the Git simulator (~1,750 lines, 281 tests)
- `engine/validators.js` — exercise validation and the guided-step cascade
- `content/course.json` — all course text (330 KB, 2,205 tests)
- `tests/` and `tools/` — except `tests/ui.test.js`, which asserts the contract
  and should be updated alongside it

**R1 · LOCKED** — The UI reads content and repo state; it never computes them.
Anything the interface shows must come from `engine.getGraph()`,
`engine.getFileState()`, `engine.run()`, `runChecks()` or `course.json`. Do not
reimplement Git logic in the view layer.

**R2 · LOCKED** — Progress persistence goes through the `ProgressStore`
interface in `ui/progress.js` and nothing else. It is the designated seam for a
future accounts backend. Do not touch `localStorage` directly.

**R3 · CONTEXT** — Content is data. Adding a twelfth module means editing
`course.json` and nothing else — the landing-page curriculum and the in-app
sidebar both render from it. Do not hard-code module or lesson lists anywhere.

---

## 4. The four surfaces

Routing is hash-based so the app deploys as static files behind any server,
including from a subdirectory.

### 4.1 Landing page — `index.html`

**R4 · OPEN** — Sections currently present: hero with a static terminal-and-graph
illustration, three feature cards, the 11-module curriculum grid, a video slot, a
closing call to action, a footer. Keep, cut, reorder or replace as you see fit.

**R5 · LOCKED** — The curriculum grid renders from `course.json` into
`#module-grid` by `ui/landing.js`. Each card gets module number, title, summary,
and a status of `available` or `coming soon`. Ship an empty container, not
hard-coded cards.

**R6 · LOCKED** — If `course.json` fails to load, the curriculum section must
degrade to a visible fallback (`#curriculum-fallback`, hidden by default) rather
than an empty hole.

**R7 · LOCKED** — The video slot (`#video-frame`) holds a placeholder until
`meta.youtubeVideoId` is set in `course.json`, at which point the script swaps in
a `youtube-nocookie` iframe. Design both states; the embed is 16:9.

### 4.2 Lesson reader — `#/lesson/<id>`

**R8 · CONTEXT** — Concept and recap lessons are pure reading: no terminal, no
panels. This is where the course does its actual teaching and where a learner
spends the most continuous time. It deserves genuine reading typography.

**R9 · LOCKED** — Eight content block types must each have a distinct treatment.
Frequencies across the whole course:

| Block | Count | What it is |
|---|---:|---|
| `p` | 222 | Body paragraph. Supports inline `code`, **bold**, *italic*. |
| `h` | 73 | Subheading within a lesson. |
| `list` | 38 | Unordered list, up to 9 items. |
| `tip` | 34 | Helpful aside. Positive tone. |
| `graph` | 32 | A live commit-graph diagram with an optional caption. Rendered by replaying real engine operations, so it can never drift from real behaviour. |
| `code` | 31 | Command block, up to 14 lines. Not interactive. |
| `analogy` | 21 | The everyday comparison that carries a hard idea. The course's signature device — give it real presence. |
| `warn` | 21 | Danger or a common trap. Must read as more serious than `tip`. |

`analogy`, `tip` and `warn` must be visually distinct from one another and from
body text at a glance.

**R10 · LOCKED** — Content is escaped, then a small inline whitelist is applied:
`` `code` ``, `**bold**`, `*italic*`. Never inject raw HTML from content. This is
a security boundary, not a style choice.

**R11 · OPEN** — Concept lessons run long; the longest is 1,963 words across 55
blocks. A wall of text is the current failure. Section navigation, a progress
indicator, staged reveal, columns: designer's call.

### 4.3 Exercise workspace

**R12 · LOCKED** — Four regions must be simultaneously reachable while an
exercise is in progress: the **instructions** (guided steps or challenge goal +
checklist), the **terminal**, the **commit graph**, and the **file-state panel**.
Reachable, not necessarily all visible at once — tabs or panes are fine.

**R13 · LOCKED** — The graph and file panel must update visibly after *every*
command. Seeing cause and effect is the product. If a redraw is not noticeable,
the teaching fails.

**R14 · LOCKED** — The terminal is the primary input and needs keyboard focus on
load at desktop widths. It supports command history (↑/↓), tab completion,
`Ctrl+L` to clear and `Ctrl+C` to cancel a line. Clicking anywhere in the
terminal focuses the input — *except* when the user is selecting text to copy.

**R15 · LOCKED** — A reset control (`#reset-btn`) restores the exercise's
starting state. Learners rely on it to experiment fearlessly; it must be
findable, and it must not be so prominent that it is hit by accident.

**R16 · CONTEXT** — Guided steps auto-advance. The learner types a command; if
the resulting repo state satisfies that step's checks, the step ticks off on its
own. One command can complete several consecutive steps. Challenge checklists
work the same way — boxes tick live as state changes, in any order.

**R17 · OPEN** — Completion currently drops a success banner into the lesson
article with a "Continue" button. The moment a learner finishes a challenge is
the emotional peak of a module and is under-designed today.

### 4.4 Playground — `#/playground`

**R18 · OPEN** — Same workspace, no goals, no checklist: a free sandbox with a
list of suggested experiments. It can afford to give the graph and terminal far
more room than a lesson does.

---

## 5. Every state to design

The current build is weakest in its edge states, and these are the ones most
often missed in a redesign. Each needs a defined appearance. Nothing here is
optional — all of these occur in normal use. **This section is the review
checklist.**

### Commit graph

- **No repository** — before `git init`. Currently an empty-state message.
- **Initialised, no commits** — a distinct state from the above.
- **Linear history** — the common case.
- **Diverged branches** — up to 3 lanes at once.
- **Merge commit** — a node with two parents, edges converging.
- **Detached HEAD** — HEAD floating on a commit, not a branch.
- **Remote refs** — `origin/main` alongside local branches.
- **Merge in progress** — a conflict is unresolved; currently a warning line.
- **Ref labels** — four kinds: current branch (HEAD →), other branch, remote,
  detached. Up to 4 on screen at once; longest is 12 characters.
- **Overflow** — graph taller or wider than its container; must stay scrollable
  with HEAD kept in view.

### File-state panel

- **No repository** — staging and history are not yet meaningful.
- **Three areas** — working directory, staging area, repository.
- **Empty area** — each of the three has its own empty message.
- **File states** — untracked, modified, deleted, staged (new), conflict,
  ignored, clean, committed.
- **Nested paths** — `site/gallery.html`, `node_modules/left-pad.js`.

### Terminal

- **Prompt variants** — plain, `(main)`, `(HEAD detached)`, `(main|MERGING)`.
- **Output categories** — nine: plain, dim, bold, error, green, red, cyan,
  yellow, and a short SHA followed by plain text.
- **Echoed command** — visually distinct from output.
- **Tab-completion list** — printed inline when ambiguous.
- **Long output** — a full `git log` or diff; must scroll within its own region.
- **Focus** — the terminal must look focused when it is.

### Guided walkthrough

- **Step: done / current / upcoming** — three clearly different treatments.
- **Step command** — 21 of them are multi-line and must render as a block.
- **Hint** — hidden by default, toggled per step.
- **Progress** — "step 4 of 9". Between 4 and 10 steps per lesson.
- **Long instruction** — up to 119 words on a single step.

### Challenge

- **Goal statement** — up to 110 words.
- **Checklist item: pending / passed** — up to 9 items, ticking live.
- **Long label** — the longest is 97 characters and must wrap, not clip.
- **Hints** — revealed one at a time, up to 5, with a button showing how many
  remain.
- **Complete** — all checks green.

### Navigation and shell

- **Module** — expanded / collapsed, and a done badge.
- **Lesson** — four types (concept, guided, challenge, recap) with distinct
  markers, plus done, current, and coming-soon.
- **Course progress** — a bar and an `n/45 · n%` pill.
- **Mobile drawer** — open, closed, and the scrim behind it.
- **Reset progress** — a destructive control, confirmed before it fires.
- **Failed to load** — `course.json` unreachable; must explain the likely cause.

> **Coming-soon lessons.** No lesson currently uses this flag — all 11 modules
> ship — but the code path is live and content authors rely on it for scaffolding
> a module before writing it. Keep a defined appearance for a lesson that exists
> in the sidebar but has no content yet.

---

## 6. Data and real volumes

Measured from the shipping course, not estimated. Design to these numbers so
nothing breaks on real content.

### Course size

| Dimension | Value | Note |
|---|---:|---|
| Modules | 11 | All shipping |
| Lessons | 34 | 12 concept, 11 guided, 11 challenge |
| Recaps | 11 | One per module |
| Navigable units | 45 | Drives the progress denominator |
| Content blocks | 472 | Across all lessons and recaps |
| Graph diagrams | 32 | Inline in lesson bodies |
| Longest lesson | 1,963 w | 55 blocks, module 7 concept |
| Longest module title | 35 ch | "Status & Diff: Reading What Changed" |
| Longest lesson title | 45 ch | "init: putting a folder under Git's protection" |

### Worst-case render load

| Element | Max | Where |
|---|---:|---|
| Commits in one graph | 7 | Module 8 recap diagram |
| Branch lanes | 3 | Module 6 guided |
| Ref labels at once | 4 | `main`, `add-faq`, `trip-reports`, `origin/main` |
| Guided steps | 10 | Module 5 |
| Checklist items | 9 | Module 10 challenge |
| Hints | 5 | Module 8 challenge |
| List items in a block | 9 | — |
| Code block lines | 14 | — |

**R19 · CONTEXT** — A learner's own repo can exceed these figures; the playground
has no ceiling. Treat the table as the design target, not a hard maximum, and
make sure overflow degrades gracefully rather than clipping.

### Shapes the UI consumes

```js
engine.getGraph() → {
  initialized, merging,
  commits: [{ id, short, parents[], message, seq, branchHint }],
  branches: [{ name, tip, current }],
  remoteBranches: [{ name, tip }],
  head: { detached, id, ref }
}

engine.getFileState() → {
  initialized, merging,
  working: [{ path, state }],   // untracked | modified | deleted | conflict | ignored | clean
  index:   [{ path, state }],   // added | modified | deleted | clean
  repo:    [{ path, state }]    // committed
}

engine.run(line) → { output, error, clear }
```

---

## 7. The DOM contract

`ui/app.js` and `ui/landing.js` look these up by ID. A missing element throws at
runtime or silently does nothing. `tests/ui.test.js` enforces the list.

**R20 · LOCKED** — These IDs must exist in the shell HTML with these
responsibilities. Their markup, nesting, classes and appearance are free; the IDs
and what they hold are not.

Required in `app.html`:

| ID | Holds |
|---|---|
| `#brand-name` | Product name, set from `course.json` |
| `#crumb` | Current module breadcrumb |
| `#progress-bar-fill` | Bar whose `width` is set as a percentage |
| `#progress-pill` | Text, e.g. `12/45 · 27%` |
| `#menu-btn` | Mobile nav toggle; carries `aria-expanded` |
| `#sidebar` | Nav container; `.open` class toggles the drawer |
| `#sidebar-scrim` | Backdrop behind the open drawer |
| `#module-nav` | Empty container; the module tree is generated into it |
| `#reset-progress` | Clears all saved progress, after confirmation |
| `#lesson-pane` | Scroll container reset to top on navigation |
| `#lesson-article` | Lesson content is rendered into this |
| `#workspace` | Exercise region; `.hidden` for reading lessons |
| `#exercise-panel` | Guided steps or challenge panel |
| `#terminal` | Terminal root; the emulator builds its own children |
| `#reset-btn` | Restart the current exercise |
| `#graph-scroll` | Scroll container; auto-scrolled to keep HEAD visible |
| `#graph-svg` | The `<svg>` the graph is drawn into |
| `#graph-headline` | Short HEAD summary text |
| `#graph-a11y` | Visually hidden live region narrating the graph |
| `#files-panel` | File-state panel is rendered into this |

Added by the rebuild, same contract — the shell owns them, `ui/app.js` fills them:

| ID | Holds |
|---|---|
| `#ex-title` | Current exercise title, in the exercise bar |
| `#ex-ticks` | One tick per guided step / challenge condition |
| `#ex-progress` | `Step 4 of 9` or `3 of 6 conditions met` (replaces the two removed IDs) |
| `#progress-metric` | Course completion as a bare number, e.g. `27` |
| `#progress-units` | `12/45 units` |
| `#read-progress-fill` | Reading position bar whose `width` is set as a percentage |
| `#files-count` | Number of files not clean, shown on the Files control |
| `#now-text` | One-line "what am I meant to be doing", focus mode only |
| `#layout-tabs` | Split / focus buttons; `data-layout` on each, `aria-pressed` |
| `#work-tabs` | Steps / graph / files tabs; `data-tab` on each, `aria-selected` |
| `#files-btn` / `#files-close` | Open and close the file-state overlay in split mode |
| `#now-bar` | Clicking it returns to the steps tab |
| `#playground-link` / `#states-link` | Sidebar routes to `#/playground` and `#/states` |

Presentation state lives on `<body>` as `data-mode` (`read` / `exercise`),
`data-layout` (`split` / `focus`) and `data-tab`, plus a `files-open` class.
Everything in §4.3 is CSS off those four; no view is re-rendered to change shape.

Required in `index.html`:

| ID | Holds |
|---|---|
| `#module-grid` | Empty container; curriculum cards are generated into it |
| `#curriculum-fallback` | Hidden fallback shown if content fails to load |
| `#video-frame` | Placeholder, replaced by an iframe when configured |

**R21 · LOCKED** — These IDs are created at runtime by `ui/app.js` and must not
be duplicated in the shell: `#step-list`, `#check-list`, `#challenge-hints`,
`#success-banner`, `#sb-next`.

> **Amended in the rebuild.** `#guided-progress` and `#challenge-progress` are
> gone. Both are now the single `#ex-progress` in the exercise bar, which the
> shell owns, so it moves from this list to the R20 table above.
> `tests/ui.test.js` was updated with the change.

**R22 · OPEN** — If a different structure serves the design better, propose the
ID changes and the matching JavaScript edits will be made. Renaming without the
JS change is the one thing that will silently break the app.

---

## 8. Accessibility

Existing guarantees, enforced by `tests/ui.test.js`. The audience is beginners,
including people who have never used a terminal; several will be using a keyboard
or a screen reader.

**R23 · LOCKED** — Visible keyboard focus on every interactive element, via
`:focus-visible`. The course is navigated by a sidebar of links; an invisible
focus ring makes it unusable.

**R24 · LOCKED** — A `prefers-reduced-motion: reduce` block that neutralises
animation, transitions and smooth scrolling.

**R25 · LOCKED** — The commit graph is the core teaching visual and is pure SVG.
It must stay narrated into a visually hidden `aria-live="polite"` region that
updates after every command — currently a sentence like *"4 commits. HEAD is on
branch main. Branches: main, feature. Remote refs: origin/main."*

**R26 · LOCKED** — The mobile nav toggle reports state with `aria-expanded`; the
drawer closes on `Escape` and returns focus to the toggle. The active lesson link
carries `aria-current="page"`.

**R27 · LOCKED** — Colour is never the only carrier of meaning. This matters most
in two places: terminal output, where red and green distinguish errors and
additions; and the challenge checklist, where passed and pending must differ by
more than hue.

**R28 · OPEN** — Contrast targets, focus ring style, and how the terminal
reconciles a text cursor with a screen-reader-friendly input. WCAG AA on body
text is the floor.

---

## 9. Technical constraints

**R29 · LOCKED** — **No build step and no dependencies.** Plain CSS and ES
modules served as files. No bundler, no framework, no preprocessor, no npm
packages at runtime. `node_modules/` must never appear.

**R30 · LOCKED** — **No CDN and no external requests.** No hosted fonts, icon
sets, analytics or third-party CSS. Everything ships in the repo. Web fonts are
permitted only if self-hosted and committed — and weigh that against page weight,
since a first-time visitor on a phone is the target reader.

**R31 · LOCKED** — **Relative paths only.** The site must work served from a
subdirectory. No leading-slash `src` or `href`. Enforced by test.

**R32 · LOCKED** — **Mobile is a first-class target.** The landing page
advertises "works on phones". The workspace's four regions have to work on a
360px-wide screen alongside an on-screen keyboard — the hardest layout problem in
the brief. Current breakpoints are 900px and 1100px, and are not sacred.

**R33 · OPEN** — Light theme, dark theme, or both. The current build is
dark-only. A terminal-centred product has a real argument for dark; a long-form
reading experience has a real argument for light. Designer's call — but if both,
the graph SVG and the terminal palette must be defined in both.

**R34 · CONTEXT** — The graph is drawn as SVG from JavaScript (`ui/graph.js`)
using CSS classes for lanes, nodes, edges and ref pills. Restyle it through CSS;
a different visual model for the graph itself is a rewrite of that module and
worth discussing first.

---

## 10. What is yours to decide

Stated explicitly so nothing in the current build is preserved by accident. Art
direction is supplied separately; none of the following should be inferred from
what exists today.

- All colour, type, spacing, iconography and motion.
- Whether the workspace shows four regions at once, or tabs, panes, or something
  else entirely.
- Whether lesson text and the exercise share a screen or are separate steps.
- The spatial model for the commit graph — it need not be a horizontal
  left-to-right rail.
- Sidebar versus top nav versus something else; how 45 units are made navigable
  without overwhelm.
- How progress is expressed beyond a bar and a percentage.
- The landing page's entire structure and argument.
- Component vocabulary, class naming, and CSS architecture.
- Whether the terminal keeps its traffic-light window chrome.

---

## 11. Deliverables

- `index.html` and `app.html` — rebuilt shells honouring the DOM contract.
- `css/landing.css` and `css/app.css` — full replacements.
- Any changed DOM-construction inside `ui/*.js`, with the module boundaries
  intact.
- A note of any ID or structural change needed, so the JavaScript can be updated
  with it.
- Designs or notes covering every state in §5.

> **Working reference.** Run `npm run serve` and open `localhost:8000` to use the
> current build. `node tools/course-to-md.mjs` prints the whole course as
> Markdown for reading the real content while designing, rather than working from
> placeholder text.

---

## 12. Acceptance

The rebuild is accepted when all of the following hold.

**A1** — `npm test` passes: 2,551 assertions across the engine, content, UI
contract and course linter. `tests/ui.test.js` is the one that checks this
brief's contract, and should be updated in step with any agreed ID changes.

**A2** — A learner can complete module 1 through module 11 end to end without
getting stuck in the interface: every guided step advances, every challenge
checklist ticks, every success state appears.

**A3** — Every state in §5 has a defined appearance, including the empty and
error ones.

**A4** — Usable at 360px wide, keyboard-only, and with a screen reader — the
graph included.

**A5** — No build step, no dependencies, no external requests, relative paths
only.
