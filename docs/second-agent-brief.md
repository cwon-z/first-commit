# Brief: independent bug sweep

Hand this to a second agent, in a fresh session, on a clean clone. It is written
to be pasted as a prompt.

---

## The prompt

You are doing an **independent bug sweep** of First Commit, a static interactive
Git course with an optional accounts backend. It has just been deployed for the
first time and real problems showed up during that deploy. Another agent has
already done one pass. Your job is to find what that pass missed — assume it
missed things, because it did once already.

**Do not take the existing tests as evidence of correctness.** They pass. Bugs
shipped anyway. The most recent example: a submit button was rendered outside
its `<form>`, so the sign-up dialog rendered perfectly and the button did
nothing at all. Every test passed the whole time. That is the class of defect
you are hunting.

### Start here

```bash
npm test                          # 2,800+ assertions; must stay green
npm start                         # then http://localhost:8000
node tools/sweep.mjs http://localhost:8000
```

`tools/sweep.mjs` drives a real browser over the DevTools protocol and checks
every route for dead controls, broken accessibility wiring and console errors.
It currently reports nothing. **Extend it** — the routes and states it visits
are not exhaustive, and a state it never opens is a state nobody has checked.

### Where to look, in rough order of likely payoff

1. **Interaction, not markup.** Click everything, in every state. Empty forms,
   half-filled forms, wrong password, expired link, submitting twice quickly,
   pressing Enter instead of clicking. Especially: the auth dialog's four modes
   (sign in / sign up / forgot / reset), the account menu, admin write actions.
2. **The server, adversarially.** `server/` is ~900 lines with no framework.
   Malformed JSON, missing fields, wrong types, huge payloads, unicode, absent
   cookies, expired tokens, a token of the wrong kind, concurrent writes to one
   account. `tests/server.test.js` covers the happy paths and the obvious
   attacks; it does not cover everything.
3. **Deployment reality.** It runs behind a reverse proxy over HTTPS. Check
   `FC_TRUST_PROXY` handling, cookie flags, redirects, and anything that assumes
   a direct connection. Check the static allowlist in `server/index.js` really
   cannot reach `data/`, `tests/fixtures-solutions.json` (the answer to every
   challenge), or `drafts/`.
4. **The two things nobody has tested at all.** The SMTP client in
   `server/mail.js` has never spoken to a real relay. And nobody has run this
   with a screen reader or on a real phone with the on-screen keyboard up.
5. **State transitions.** Sign in as a guest with local progress and watch the
   merge. Sign out mid-exercise. Let a session expire. Reset progress while an
   exercise is open. Delete your own account while signed in on two tabs.

### Traps that will cost you an hour each

These are real and were all hit during the first pass:

- **The Bash tool collapses `\\` to `\`.** Writing JavaScript through
  `bash -c "node -e ..."` silently corrupts regexes and template literals — `\\b`
  became a literal backspace character in a test file once. Backticks inside
  double-quoted bash strings get run as command substitution. Use the Write and
  Edit tools for anything containing backslashes or backticks.
- **The production CSP has no `'unsafe-inline'`.** Inline `<script>` and
  `<style>` do not run when served by `server/index.js`. Browser test harnesses
  need external files. Symptom: a blank white page and no error.
- **`frame-ancestors 'none'` blocks all framing, including same-origin.** An
  iframe-based harness will not work against the real server. Use the DevTools
  protocol, as `tools/sweep.mjs` does.
- **Navigating to a URL that differs only in the hash does not reload.** The app
  will not re-boot, so it will not notice a login or logout you performed behind
  its back. Use `Page.reload`.
- **Line endings.** The working tree is CRLF on Windows, LF in the repository.
  Multi-line string matching fails against the wrong one. Normalise before
  editing.
- **`require()` caches JSON.** Re-reading a data file with `require` in a loop
  returns the first read forever, which will convince you a write is broken when
  it is not.

### Rules

- **No dependencies, no build step.** Not for the app, not for the server, not
  for your tooling. `node_modules/` must never appear.
- `npm test` must stay green, and `node tools/lint-course.mjs` must stay at zero
  hard errors. Its five advisory items are settled decisions — see *Vocabulary,
  decided* in the README. Do not re-litigate them.
- The course must keep working as **plain static files with no server**. Serve
  it with `npm run serve:static` and confirm. Anything that makes the backend
  required is a bug, not a feature.
- Lesson ids in `content/course.json` are permanent: they are URLs and
  progress-store keys. Insert, never renumber.
- Progress persistence goes through `ui/progress.js` and nowhere else. A test
  enforces that no other module in `ui/` mentions `localStorage`.

### What to hand back

For each finding: what breaks, the exact steps to see it, why the existing tests
missed it, and the fix. Add a regression test for anything you fix — and if the
existing test suite structurally could not have caught it, say so and extend the
sweep instead of pretending a unit test would have.

If you find nothing in an area, say that too. "I checked the reset-token flow
against replay, expiry and cross-kind reuse and found nothing" is a useful
result. "Everything looks fine" is not.

---

## Context the prompt above assumes

Recent history, so the second agent does not redo finished work:

| Already done | Where |
|---|---|
| Interface rebuilt from a design export | `css/`, `ui/`, `docs/ui-rebuild-brief.md` |
| Optional accounts, server-saved progress, owner statistics | `server/`, `admin.html` |
| Password reset, email verification, admin write actions, export/delete | `server/api.js`, `ui/auth.js` |
| Rate limiting fixed behind a proxy; outbound-mail cap | `server/auth.js` `clientIp`, `server/api.js` |
| Sign-up dialog rebuilt: confirmation field, per-field validation, reveal toggle | `ui/auth.js` |
| Font licences (OFL) shipped with the fonts | `assets/fonts/` |

Known-open, and not worth re-reporting: the SMTP client is untested against a
real relay, and the screen-reader and real-phone passes have not happened. Both
are in `TODO.md`.
