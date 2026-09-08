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

`node tools/lint-course.mjs` reports these. All are advisory — **0 hard errors**
— and they are judgement calls about writing, not bugs. Re-run the linter after
any edit; `npm test` runs it in `--strict` mode.

- [ ] **`git help` is named but not simulated.** `m11-recap` tells the learner
      to run `git help <command>`, which the sandbox does not implement. Either
      say plainly that it is a real-Git command to try later, or drop it.
      *This is the only one that could actually confuse somebody mid-course.*

- [ ] **Vocabulary drift.** The course uses two or three words for the same
      thing. Pick one per row and sweep:
      | Concept | Currently |
      |---|---|
      | repository | `repo` (81) vs `repository` (50) |
      | working directory | `working directory` (16), `working tree` (7), `your folder` (6) |
      | commit | `snapshot` (26), `save point` (2) |
      | staging area | `staging area` (23), `the stage` (1) |

      Some of this is deliberate teaching — "snapshot" earns its place early —
      so this is a read-through, not a find-and-replace.

- [ ] **Module length is uneven.** Concept words per module, against a 1,263
      mean: M1 552 · M2 249 · M3 329 · M4 1357 · M5 1347 · M6 1934 · M7 1963 ·
      M8 1423 · M9 1775 · M10 1408 · M11 1555.
      Modules 1–3 are thin and modules 6–7 may sprawl. The funnel on
      `/admin.html` will tell you which of these actually costs you learners
      once real people are using it — worth waiting for that data rather than
      guessing.

---

## Housekeeping

- [ ] **`docs/ui-rebuild-brief.md` is now half spec, half history.** It was the
      input brief; the rebuild is done and the document carries an amendment
      note. Either fold it into the README as "why the UI is shaped this way"
      or move it to `docs/history/`.

- [ ] **The landing page's "12 minutes" is hardcoded** next to the video
      heading, the same way the module counts used to be. Harmless until the
      video exists, then it should come from `course.json` like everything else.
