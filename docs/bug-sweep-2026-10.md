# Bug sweep — 2026-10-03

Prompted by two reports: something wrong with the website, and learners losing
progress. Before this sweep all suites passed and both browser sweeps reported
no findings. Every defect below was reproduced before it was fixed, and every
fix has a regression test that fails against the previous code.

## Progress saving

### 1. Any second tab or device erased progress

Every open page saves its whole copy on each lesson it *shows*, and both stores
replaced the stored document with whatever arrived. A tab left open on an old
copy wiped everything finished since — and so did a laptop left open while the
learner carried on from a phone, the one thing accounts exist for.

Reproduced three ways: two guest tabs sharing `localStorage` (affects every
deployment, static included), two clients on one account over HTTP, and the
same in a real browser. An admin's *Reset* was also silently undone by the
learner's next save from an open tab.

**Fix.** A save folds into the stored copy; completions only accumulate
(`foldProgress` in `ui/progress.js` and `server/api.js`, same rule). A reset is
the one thing that removes them: it writes a `resetAt` marker, and a copy from
before that marker gets the reset rather than restoring its list. A copy without
`resetAt` (an older client, or a page that could not load the account) is folded
in as current, so nothing older is locked out. Both stores answer a save with
what they now hold, and the page adopts it — another device's lessons appear in
the sidebar on the next navigation.

### 2. Overlapping saves landed out of order

Saves were fired without waiting for each other. The first request after five
idle minutes takes a slower path (it records `lastSeenAt`), so the next request
overtook it and the older copy was written last. Saves are now queued one at a
time, and a save asked for while one waits sends whatever is current when it
goes.

### 3. A refused save was lost with the tab

Offline, session ended, or address not yet confirmed: the page held the only
copy. It is now kept in `localStorage` under the account's id
(`first-commit.unsent.v1.<id>`, documented in PRIVACY.md), retried when the
browser comes back online, and delivered with the next save or sign-in to that
account. It is never mixed into another account's progress on a shared browser,
and work kept from before a reset made elsewhere is discarded.

### 4. Failing to read the account broke the course

If `GET /api/progress` failed at start-up the course showed "could not be
loaded — this means you opened it from `file://`". Signing in switched the store
before reading the account, so a failed read left the guest's copy saving over
the account's. The course now opens with an empty copy and a save note; with
folding, the first save that gets through erases nothing and brings the
account's progress back.

### 5. Verification required, but no mail — nobody new can save

With `FC_REQUIRE_VERIFICATION=1` and no `FC_SMTP_URL`, confirmation links are
only written to `data/outbox/`, so no new account can ever confirm and every
save is refused with 403. `deploy/app.env.example` shipped exactly that
combination: verification on, SMTP commented out. TODO.md records SMTP as not
yet configured.

The example now leaves verification off until mail works, the server prints a
loud warning at start-up for this combination, and the account menu stops
claiming "Progress saved to your account" when the server is refusing every save.
**If the live site has this combination, it alone explains the reports.**

## Deployment checks

- `FC_REQUIRE_VERIFICATION` must not be `1` until `FC_SMTP_URL` is set and a
  message has actually arrived (see 5).
- `deploy/nginx.example.conf` sent no `Cache-Control` for HTML, so browsers
  guessed a lifetime and could pair an old `app.html` with new JavaScript after
  a deploy. HTML now revalidates, as the Node server already did.
- Not changed, worth knowing: the nginx example serves the static course with
  none of the security headers the Node server sends (CSP, `X-Frame-Options`,
  `nosniff`). Adding them in nginx needs care: a `location` with its own
  `add_header` drops every inherited one.

## Server

- **One unreadable static file took the whole server down.** A file that passes
  `stat` but fails to open (removed by a deploy in between, wrong permissions,
  out of file descriptors) emitted an unhandled stream error and crashed the
  process. Now served with `stream.pipeline`, which also closes the file when a
  visitor disconnects mid-download.

## The git sandbox

- **Switching branches destroyed staged work.** Staged new files were deleted
  and staged edits unstaged. Module 5's challenge, done the natural way (stage
  the draft, make the branch, switch), destroyed the draft it asks you to move.
- **`git reset` did not end a merge.** After `reset --hard` mid-conflict, status
  still said "You have unmerged paths" and module 6's guided step never passed.
  `reset --soft` mid-merge is now refused, as in real git.
- **`HEAD@{n}` was rejected**, although module 9 teaches it.
- **Merge, pull and detached checkout overwrote untracked files.** Switching
  already refused; these now refuse the same way.

## The interface

- **The commit graph hid forks.** Lanes were chosen by branch name alone, so a
  teammate's commits and the learner's — both on `main` — shared a lane. Right
  after a rejected push the graph showed `main` one commit ahead of
  `origin/main`, and module 7's "One fork, three names" figure was a straight
  line. A commit whose parent's lane has moved on now opens its own lane. Of
  the course's 34 graphs, only those two change.
- **"Run it for me" could not finish 21 guided steps.** It ran only the first of
  a step's two commands. Pasting two lines into the terminal also ran them as
  one wrong command; each line now runs in turn.
- **Keyboard trap.** Tab never left the terminal. It now completes only when
  there is something to complete.
- **IME.** Enter that finished composing a Korean, Japanese or Chinese word ran
  the command half-typed.
- **Tab completion** rewrote the whole line, collapsing spaces inside quoted
  `echo` text and dropping the quotes a filename with spaces needs.
- **`cat` output was coloured as a diff.** Lines beginning "- " showed as red
  deletions — in the lesson that teaches reading diffs.
- **Phone layout.** The reset button was off-screen in every challenge. A long
  display name (the default is the part of the address before the `@`) pushed
  the account control off the top bar, and "Open the course" off the landing
  page; with the save note showing, the account button disappeared entirely. A
  long branch name squeezed the command input to zero width. The Graph tab
  opened at the oldest commits, and the "now" bar grew to 156px.
- **Focus visibility.** Module cards, pill tabs, the active lesson and the now
  bar showed no focus ring, and nothing did in forced-colours mode.
- **Admin.** One very long address pushed every row's actions off the page.

## Found, not fixed

Recorded for a later pass; each was reproduced by the audit, with scripts.

**Sandbox, will mislead a learner who tries it:**

- `stash pop`/`apply` restores and re-stages every tracked file, not only the
  stashed ones, and `stash@{n}` always means 0.
- `git reset <file>` is fatal and `git reset HEAD <file>` unstages everything;
  `reset --hard HEAD <file>` resets the whole tree.
- `switch -c <name> <start>` moves HEAD but not the files.
- `checkout <rev> -- <file>` detaches HEAD; `restore --source` is ignored;
  `restore .` and `checkout .` fail.
- Rebase silently resolves add/add in its favour; `merge --abort` deletes
  untracked files created mid-conflict.
- A merge is refused when unrelated files are dirty.
- Same-file edits on different lines always conflict on the whole file. This is
  not in the README's list of limitations.
- `merge --no-ff`, `pull --rebase` and `push --delete` are ignored rather than
  refused; `-m ""` creates a commit; `branch -m`/`-M` are missing.
- Invalid branch names are accepted. Names such as `constructor` and
  `__proto__` break commands.

**Validators:** challenges without a `headOnBranch` check pass on a detached
HEAD (m4l3, m10l3, m11l3).

**Interface:**

- Ref labels on lower lanes overlap the lane above. More visible now that forks
  are drawn. The fix changes the height of every multi-lane figure, so it is a
  design call.
- `git status` entries still carry the "−" deletion mark.
- Admin page: focus is lost after Reset/Delete; a non-owner sees a console 403
  and text that is wrong when `FC_OWNER_EMAILS` is set; sticky headers do not
  stick.
- Two `#/states` gallery plates show the wrong state.
- HEAD can scroll under the Files overlay.

## Validation

```text
npm test                                    # 2,900+ assertions, all passing
node tools/sweep.mjs --accounts             # all routes, 42 behaviour checks
node tools/sweep.mjs <static server> --static
```

New coverage: `tests/progress.test.js` (the browser's stores against the real
server), progress folding in `tests/server.test.js`, four engine sections in
`tests/engine.test.js`, the static-file crash in `tests/adversarial.test.js`, and
progress, terminal and phone-layout flows in `tools/sweep-flows.mjs`.

Not covered: the live deployment's configuration, real SMTP delivery, and a
physical phone with its keyboard raised.
