# TODO

What is left. Nothing here is broken — the course runs, all 45 units play
through end to end, and 2,690 assertions pass. These are the things that are
either waiting on a person, waiting on a decision, or judgement calls about
content.

Grouped by what is blocking them, not by priority, because the blocker is
usually the thing that decides what you can pick up today.

**Done and not to be re-litigated:** the interface rebuild, the state-reference
gallery, optional accounts with server-saved progress, and the owner statistics
page. See the last four commits.

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

- [ ] **Push.** `main` is ahead of `origin/main`. Nothing has been pushed yet.

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

## Housekeeping

- [ ] **`docs/ui-rebuild-brief.md` is now half spec, half history.** It was the
      input brief; the rebuild is done and the document carries an amendment
      note. Either fold it into the README as "why the UI is shaped this way"
      or move it to `docs/history/`.

- [ ] **The landing page's "12 minutes" is hardcoded** next to the video
      heading, the same way the module counts used to be. Harmless until the
      video exists, then it should come from `course.json` like everything else.
