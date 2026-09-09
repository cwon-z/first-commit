# Privacy

This describes what First Commit stores, why, and how to get rid of it. It is
written to be true rather than to be safe, so where something is a real
limitation it says so.

There are two ways to run this course, and they collect different amounts.

## Served as static files — nothing leaves your browser

The default. No accounts, no server, no requests to anyone. Your progress is
kept in your own browser's `localStorage` under `first-commit.progress.v1`, and
your layout preference under `first-commit.prefs.v1`. Clearing your site data
erases both. Nobody, including whoever published the course, can see them.

## Run with the optional accounts server

Signing in is optional even here: you can finish the whole course as a guest and
never make an account. An account exists to do one thing — carry your progress
to another device.

### What is stored, if you make an account

| | | |
|---|---|---|
| Email address | so you can sign in, and so a reset link has somewhere to go | until you delete the account |
| Display name | so the course owner sees a name instead of an address; optional, defaults to the part of your address before the `@` | until you delete the account |
| Password | as a scrypt hash with a random salt. The password itself is never written down and cannot be recovered from the hash — this is why a forgotten password is reset, never retrieved | until you delete the account |
| Which units you finished, and where you left off | so it can be given back to you on another device | until you delete the account |
| Sessions | a random token, stored only as its SHA-256, so a copy of the data file does not hand over live logins | 30 days, or until you sign out |
| Verification and reset links | the same way, one at a time | 24 hours and 1 hour respectively, and consumed on first use |
| Account created, last seen | so the owner can see who is active | until you delete the account |

### What is not stored

- **No IP addresses.** Sign-in attempts are rate-limited per address, but that
  counter lives in memory and is gone when the server restarts. Nothing is
  written to disk: the web server in front of the course is configured with
  `access_log off`, so requests are not journalled either.

  One honest caveat, because it is true of any hosted thing: whoever runs the
  network between you and the server sees the connection. If this instance is
  behind a CDN or a tunnel — the one at learngit.cwonr.com is behind Cloudflare
  — then that provider sees your address the way your own ISP does. That is
  outside what the course stores, and it is not something a privacy policy can
  promise away.
- **No analytics, no tracking, no third-party requests.** The course loads no
  scripts, fonts or styles from anywhere but the server you are on. The only
  outbound connection the server ever makes is to a mail relay, and only if the
  owner configured one.
- **No cookies except the session.** One cookie, `fc_session`, set only after
  you sign in. It is HttpOnly and SameSite=Lax.
- **Nothing about what you type in the terminal.** The Git simulator runs
  entirely in your browser. The server is told which units you finished, never
  what commands you ran to finish them.

### Who can see it

- **You** — everything, via *Download my data* in the account menu.
- **The course owner** — the statistics page shows every learner's address,
  name, completion, last-opened unit and last-seen time. It cannot show your
  password, because nobody has it.
- **Nobody else.** One learner cannot read or write another's progress; that is
  asserted in `tests/server.test.js`, not just intended.

### Getting rid of it

- **Download my data** in the account menu exports everything above as JSON.
- **Delete my account** in the same menu removes the account, the progress, the
  sessions and any outstanding links, immediately and without a grace period.
  It cannot be undone.
- The course owner can also reset your progress or delete your account from the
  statistics page.

### Where it lives

One JSON file on the owner's server (`data/first-commit.json` by default). It is
never committed to the repository. Backups, retention and disk encryption are
the owner's responsibility, and this document cannot promise anything about
them — ask whoever runs the instance you are using.

### Email

Only sent for two reasons: confirming your address when you sign up, and
resetting your password when you ask. Never for anything else. If the owner has
not configured a mail relay, no email is sent at all and the messages are
written to a folder on the server instead.

---

*If you are running this course for other people, this file describes the
software's behaviour, not your legal obligations. Those depend on where you and
your learners are.*
