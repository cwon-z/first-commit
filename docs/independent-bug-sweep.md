# Independent bug sweep — 2026-09-09

The clean-clone baseline passed all 2,808 assertions and the original browser
sweep reported no findings. The checks below nevertheless reproduced failures.
All listed fixes are included in this change. No dependencies, build step,
lesson-id changes, or production account data were needed.

## Findings and reproductions

### 1. A malformed HTTP request target crashes the process

Send a raw HTTP request with target `http://[`, for example
`http.get(base, {path: 'http://['})`. The URL constructor threw before the
request handler's try/catch, terminating Node rather than answering the client.
URL parsing now has a 400 response path. The new HTTP regression also checks
that the course still responds afterwards.

Existing tests used well-formed fetch URLs; fetch itself prevents this request.
Regression: `tests/adversarial.test.js`, malformed request targets.

### 2. Concurrent registration violates email uniqueness and ownership

On an empty, unconfigured instance, send two registrations together. Both could
become owners. Send two registrations for the same normalized address together:
both could return 201 and create distinct accounts for that address.

The uniqueness and first-owner decisions ran before asynchronous password
hashing. They now run inside the serialized write. Tests hold the first two
writes at a barrier to reproduce the overlap independently of disk speed.

Existing registration tests were sequential. Regression:
`tests/adversarial.test.js`, simultaneous first and duplicate registrations.

### 3. A reset link can be spent twice concurrently

Obtain one reset link and POST it twice concurrently with different new
passwords. Both requests could return 200. Token lookup and deletion were
separate operations; the validity check now runs again inside the deletion
transaction. Exactly one request succeeds.

Existing replay coverage tried the second request after the first finished.
Regression: `tests/adversarial.test.js`, concurrent reset-token consumption.

### 4. Parallel attempts bypass rate limiting

Configure a sign-up limit of one and send four requests concurrently. All four
could return 201. Login had the same check-before-hashing/count-after-hashing
window. Attempts are now recorded before the asynchronous work begins.

Existing rate-limiter tests counted completed attempts sequentially.
Regression: `tests/adversarial.test.js`, burst requests, including a trusted
proxy header and a different client address.

### 5. Non-object JSON and non-string credentials reach server internals

POST literal JSON `null` to registration: the API returned 500 reading
`body.email`. Send a known email and a null/object password to login: scrypt
threw. Some non-string registration values passed string-coercing validation
and failed later; array email addresses were silently accepted.

Body-reading routes now require a JSON object. Password validation and
verification require strings, and email normalization no longer coerces
arrays/objects into addresses. Bad input gets 400, or the normal generic 401
for incorrect login credentials.

Existing tests mostly sent correctly typed objects. Regression:
`tests/adversarial.test.js`, JSON-type matrix and credential types.

### 6. Oversized requests lose the promised 413 response

POST a JSON object containing a 270,000-character string. The client received a
connection failure because the server destroyed the request socket before its
error response could arrive. The reader now drops buffered data and drains
further chunks while returning JSON 413.

Existing tests did not exercise the body-size boundary.
Regression: `tests/adversarial.test.js`, oversized JSON.

### 7. SMTP replies are parsed before their final line arrives

Give `SmtpSession` a chunk ending in `250 START`, then a later chunk containing
`TLS\r\n`. The first chunk prematurely completed the reply, losing STARTTLS
from the capabilities. A greeting received before `reply()` was also discarded,
and a new waiter after disconnect could hang.

Only newline-terminated lines now complete replies. Early replies are queued,
disconnect state is retained, and commands register their waiter before writing.
Regression: `tests/mail.test.js` uses an event-driven socket fixture.

The old server tests replaced the entire mail transport. This is parser
coverage, not proof of successful submission to a real TLS relay.

### 8. Landing-page authentication skips the guest-progress merge

Complete a lesson as a guest, return to the landing page, then sign up there.
The browser redirected into the course, loaded only remote progress, and showed
the completed lesson as unfinished. Merge logic previously ran only in the
already-open course's account callback.

Course boot now merges guest progress for an authenticated session too. A
successful remote save clears the transferred guest document so a later reset
or another account does not re-import it. Failed saves retain the guest copy.
Verification-required save failures now say to confirm the email.

The old merge unit test proved union arithmetic, not either entry-point flow.
Regression: `tools/sweep-flows.mjs`, landing sign-up submitted with Enter.

### 9. Email confirmation impersonates a login in the UI

Open a valid verification link while signed out. The account menu displayed the
verified user even though `auth/me` still returned null and no session cookie
had been issued. Opening another person's confirmation link while signed in
could similarly paint the wrong account.

The UI now probes the actual session after confirming the address. Account
changes also keep the app's session record current.

Existing tests validated verification responses, not what the browser did with
them. Regression: `tools/sweep-flows.mjs`, signed-out email confirmation.

### 10. Pending authentication can outlive its dialog or be submitted twice

Delay a registration response, submit the form, then press Escape or switch
modes. The request could still set a session cookie after the dialog resolved
as dismissed, leaving the course in a guest state. Repeated submit events also
started additional requests because only the button was disabled.

A busy guard now permits one request, disables mode/dismissal controls, and
prevents Escape or backdrop dismissal until it settles. Close is idempotent.

The old sweep detected handlers, not request lifetimes. Regression:
`tools/sweep-flows.mjs`, delayed real registration plus repeated submit/Escape.

### 11. Dismissing authentication loses keyboard focus

Focus Sign in, open the dialog, then press Escape. Focus fell back to the page
body because the focused input was removed. The dialog now restores its opener
when that element remains connected.

Source-level accessibility checks cannot establish runtime focus behavior.
Regression: `tools/sweep-flows.mjs`, opener focus after Escape.

### 12. Failed logout falsely reports success

Sign in, make the logout request fail (for example, disconnect), then click
Sign out. The error was swallowed and the UI painted a guest despite the live
server session. It now retains the account control and offers a retry.

The old logout test covered a successful HTTP request. Regression:
`tools/sweep-flows.mjs`, an injected logout network failure.

### 13. Static admin Refresh is an unwired button

Run `npm run serve:static`, open `admin.html`, and click Refresh. Static boot
returned before attaching the handler. The handler is now attached before
probing the optional server.

The old sweep visited admin only with the backend running. Regression:
`tools/sweep.mjs http://localhost:8000 --static`, dead-control probe.

## Sweep coverage repaired

The previous “account menu open” preparation silently succeeded without an
account, and its “success dialog” preparation clicked a concept's Continue
button, which navigates instead of opening that dialog. Neither claimed state
was actually inspected. Preparation failures now count as findings; the success
case completes a guided exercise, and account checks use disposable real users.

The extended sweep visits all 47 lesson/recap routes, plus the landing page,
playground, state gallery, overlays, and admin. It tests all four auth modes,
validation errors, Enter submission, delayed submissions, account transitions,
admin resend/reset/delete/filter, progress reset with an exercise open, session
expiry, and phone-width horizontal overflow. Open account, forgot/reset forms,
and the populated owner table also receive structural accessibility checks.
Evaluation exceptions now fail the sweep instead of silently yielding no data.

## Checked without additional findings

- Decoded traversal attempts and direct requests for account data, challenge
  solutions, and drafts returned 404. This does not test deployment-added
  symlinks or a proxy's separate static-file configuration.
- Sequential token replay, expiry, and wrong-kind reuse were rejected; a
  rejected wrong-kind use did not consume the legitimate verification token.
- Deleting a learner revoked both independently issued sessions. This was an
  HTTP two-session check, not a physical two-tab UI walkthrough.
- Valid one- and two-proxy address selection and forged-prefix handling pass
  existing tests. The new burst test confirms separate client buckets and
  Secure cookies on login/registration and logout with the option enabled.
  No live HTTPS proxy was available.
- Admin resend, progress reset, deletion, and empty search results worked in the
  browser. Progress reset left the exercise terminal usable.
- Expired sessions cannot export account data; the open course displays an
  unsaved-progress notice after its next save.
- Static mode completes a guided exercise and preserves that completion across
  page reloads, with the account control hidden.

## Validation and limits

Run:

```text
npm test
node tools/lint-course.mjs
node tools/sweep.mjs --accounts
npm run serve:static
node tools/sweep.mjs http://localhost:8000 --static
```

`--accounts` creates an isolated local server with a scratch database and a
capturing mail transport; it never exercises write actions against a supplied
deployment URL. `--flows-only` is available with `--accounts` for focused
behavioral checks. Browser tooling uses Node's built-in WebSocket (Node 22+);
the application/server's Node 18 minimum is unchanged.

The full suites pass locally on Node 26.3.0. Both complete browser sweeps pass,
and the course linter retains zero hard errors and the five settled advisories.
No packages were installed.

Real SMTP submission, screen-reader speech, and a physical phone with its
on-screen keyboard remain the already-known acceptance gaps. Viewport emulation
and a socket fixture do not close them. This sweep is broader coverage, not a
claim that every possible timing, transport failure, or device state was tested.
