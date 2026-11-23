# TODO

What is left after the independent bug sweep. All 47 course units pass the
content checks, and the automated suites pass. These are the things that are
either waiting on a person, waiting on a decision, or judgement calls about
content.

Grouped by what is blocking them, not by priority, because the blocker is
usually the thing that decides what you can pick up today.

**Done and not to be re-litigated:** the interface rebuild, the state-reference
gallery, optional accounts with server-saved progress, and the owner statistics
page. See the README and the independent sweep report.

---

## Settled

- [x] **Password reset** — self-service, single-use links, one hour, and using
      one signs every other device out.
- [x] **Email verification** — on by default when mail is configured;
      `FC_REQUIRE_VERIFICATION=1` makes it mandatory.
- [x] **Admin write actions** — reset a learner, delete an account, resend a
      confirmation, from the statistics page.
- [x] **Privacy** — [PRIVACY.md](PRIVACY.md), plus self-service export and
      deletion.
- [x] **Ownership** — `FC_OWNER_EMAILS` closes the first-to-register hole.
- [x] **Repository layout** — one public repo. Secrets are environment
      variables, never files. See the README.
- [x] **Backups** — handled on your server, out of this repository's scope.
- [x] **The two scratch files** — now git-ignored rather than untracked.

- [x] **Sign-up and sign-in rebuilt** — confirmation field, per-field
      validation before any request, password reveal, server errors attached to
      the field they are about.
- [x] **Font licences** — the OFL text and copyright now ship with the fonts,
      which the licence requires and we were not doing.
- [x] **Interaction sweep** — `tools/sweep.mjs`, covering all 47 course units,
      account/admin interactions, and static mode. It catches the class of bug
      the other suites cannot: a control that renders perfectly and does nothing.
- [x] **Second opinion.** Independent clean-clone sweep completed; 13 defect
      groups fixed with HTTP, SMTP-parser, and real-browser regressions.
      See [the findings and validation](docs/independent-bug-sweep.md).
- [x] **Progress that went missing.** Saves now fold rather than replace, so a
      second tab or device can no longer erase work; refused saves are kept on
      the device; plus sandbox, terminal and phone-layout fixes.
      See [the October sweep](docs/bug-sweep-2026-10.md).

## Waiting on a person

These cannot be closed from a terminal. Both are listed as acceptance criteria
in `docs/ui-rebuild-brief.md` §12 (A4).

- [ ] **Screen-reader pass.** Markup, focus order, the `aria-live` graph
      narration and the focus trap in the sign-in dialog are all in place and
      asserted by `tests/ui.test.js`. What none of that proves is how it
      actually *sounds*. Walk one concept lesson, one guided exercise and one
      challenge with NVDA or VoiceOver.
      *Watch for:* whether the commit-graph narration is useful or just noisy
      after every command, and whether the terminal's output region interrupts
      too often. **Medium.**

- [ ] **A real phone, with the on-screen keyboard up.** The brief calls this the
      hardest layout problem in the project (R32). The 390px layout is verified,
      but a headless browser cannot raise a keyboard over the pinned terminal.
      *Watch for:* whether the terminal input stays visible when focused, and
      whether the "now" bar and tab row survive the reduced viewport.
      **Small, but only doable on a device.**

---

## Waiting on a decision

- [ ] **Publish.** Push the reviewed changes and make the repository public
      when ready. Local commits do not change repository visibility.

- [ ] **Deploy with the public settings.** Sign-up is going to be open to
      strangers, so `FC_TRUST_PROXY=1` and `FC_REQUIRE_VERIFICATION=1` matter
      as much as `FC_OWNER_EMAILS`. The README has a working configuration
      under *Opening it to people you don't know*. **But not
      `FC_REQUIRE_VERIFICATION=1` before the mail relay below works:** without
      it nobody can confirm, so no new learner can save progress at all. The
      server now warns about that combination at start-up.

- [ ] **A real mail relay.** `FC_SMTP_URL` is unset, so verification and reset
      links are written to `data/outbox/` and printed to the console rather than
      sent. That is fine for people you know and not fine for strangers. The
      SMTP client is written but has never spoken to a real relay — first
      deployment is its first test.

- [ ] **The video.** `meta.youtubeVideoId` is empty, so the whole video section
      is now hidden rather than showing a placeholder. Set the id when the video
      exists and the section comes back on its own.

## Content review

Done, and the linter is down from eleven advisory items to five — all five now
deliberate rather than outstanding, and recorded in the README under
*Vocabulary, decided*.

- [x] **`git help` framed as real Git.** The surrounding list was always about
      using Git outside the sandbox; now the sentence says so.
- [x] **Modules 1–3 were thin.** Module 2 taught the ceremony of committing
      without ever saying what a commit contains, and module 3 promised
      un-staging in its own summary and never taught it. Two new concept
      lessons (`m2l1b`, `m3l1b`) and a section in `m1l2` on why a commit is a
      snapshot rather than a stack of diffs. 45 units → 47; every length
      outlier is gone.
- [x] **Vocabulary.** One real fix — module 5 now says *working directory*
      where it is teaching the idea. The rest are kept on purpose and written
      up so they are not re-litigated each time the linter prints them.

Still open, and better answered by data than by guessing: **which units people
actually stop at.** The funnel on `/admin.html` will say, once real learners are
using it. Rewriting on a hunch before then is how you fix the wrong module.

## From the October sweep

Reproduced, not yet fixed; details and repro steps in
[the sweep report](docs/bug-sweep-2026-10.md#found-not-fixed).

- [ ] **Sandbox commands that mislead whoever tries them** — `stash pop`
      restores more than was stashed, `git reset <file>`, `switch -c <name>
      <start>`, `checkout <rev> -- <file>`, whole-file conflicts for edits on
      different lines. **Medium.** (`restore .`, `-m ""`, `branch -m`, and
      flags silently ignored by `restore` / `diff` / `log` were fixed in the
      curriculum review below; other commands still ignore flags they do not
      know.)
- [ ] **Challenges pass on a detached HEAD** where they lack `headOnBranch`
      (m4l3, m10l3, m11l3). **Small.**
- [ ] **Graph labels on lower lanes overlap the lane above.** The fix makes
      every multi-lane figure taller, so it needs a design decision. **Small.**
- [ ] **Smaller interface items** — admin focus after Reset/Delete, the
      non-owner admin message, status lines' "−" mark, two `#/states` plates.

## From the curriculum review

Every exercise was played blind — from the lesson text, the goal and the hints
alone — and every claim about Git checked against real Git. What that found is
fixed: checklists that accepted the wrong history or rejected the right one,
walkthroughs that could not be finished after a legitimate choice, lessons that
pointed at parts of the interface that are not where they said, and a sandbox
that quietly did something other than what was typed. These are what is left.

- [ ] **Run the browser sweep before deploying.** The review changed how hints
      and checklist labels are rendered and what several lessons say about the
      interface (**Files**, **reset**). That was checked against the markup and
      stylesheet, not in a browser. `node tools/sweep.mjs --accounts`, then look
      at one guided lesson and one challenge by eye. **Small.**
- [ ] **Sandbox output that still differs from Git** — `git diff` during a
      conflict prints `new file mode` for the conflicted file; `git merge
      --continue` is not understood; `git status` before the first commit
      suggests `git restore --staged` where Git says `git rm --cached`;
      untracked folders are listed file by file where Git prints one
      `folder/` line (module 10 says so); `git revert` of an already-reverted
      commit reports a conflict; `git pull` on a branch with no upstream
      suggests a command that then fails. None blocks an exercise. **Small each.**
- [ ] **Walkthroughs can still be left behind by going off-script** — for
      instance committing on `main` in the module 5 walkthrough, or merging the
      two branches in the other order in module 6. Module 1 now says what
      **reset** is for, and the steps most likely to strand someone say it
      again in their hints, but there is no general "this walkthrough cannot
      continue from here" notice. **Medium, and a design question.**
- [ ] **A message check can only measure.** Module 11's challenge now checks
      all three commits' messages, but only for length — "asdf asdf asdf" would
      pass. Anything stricter starts rejecting good messages.

## Housekeeping

- [ ] **`docs/ui-rebuild-brief.md` is now half spec, half history.** It was the
      input brief; the rebuild is done and the document carries an amendment
      note. Either fold it into the README as "why the UI is shaped this way"
      or move it to `docs/history/`.

- [ ] **The landing page's "12 minutes" is hardcoded** next to the video
      heading, the same way the module counts used to be. Harmless until the
      video exists, then it should come from `course.json` like everything else.
