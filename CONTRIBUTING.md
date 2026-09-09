# Contributing

First Commit has no dependencies or build step. Use Node 18+ for the course and
server tests; the optional browser sweep needs Node 22+ and Chrome/Chromium.

Before proposing a change, run:

```text
npm test
```

For UI or account changes, also run `node tools/sweep.mjs --accounts`. This
uses disposable accounts and captures mail locally. Check static mode with
`npm run serve:static`, then `node tools/sweep.mjs http://localhost:8000 --static`.
See the README for architecture and content-authoring tools.

- Keep the course usable without an accounts backend.
- Add no packages or build step, including for tests and tools.
- Keep lesson IDs stable; existing links and progress depend on them.
- Access browser persistence through `ui/progress.js`.
- Add a regression check for a bug fix. UI behavior needs a browser check when
  source-level assertions cannot reproduce it.
- Keep account data, mail files, local environment files, and credentials out
  of commits. Deployment examples must use placeholders.

Describe the problem, resulting behavior, and checks performed in the pull
request. The five settled course-linter advisories are documented in the README.
