# Public repository hygiene review — 2026-09-09

Verdict: no repository-publication blocker found in the inspected local refs
and pending changes. This review covers publishing source, not readiness of a
particular public accounts deployment.

## Inspected

- All 28 commits reachable from local refs and their 196 unique blobs, plus
  tracked and pending source files. Pattern checks covered private keys,
  common service tokens, credential-bearing URLs, environment assignments,
  sensitive filenames, personal machine paths, and oversized files.
- Scan candidates were placeholder SMTP credentials and the simulator's
  `/home/learner/project` path. No live credential or account database was
  identified. No blob exceeded 1 MB, and no data/mail/private-key path appeared
  in reachable history. Pattern scanning cannot prove the absence of every
  possible secret.
- MIT license, bundled font notices and OFL license files are present.
- Deployment examples use placeholders. Scratch HTML exports, candidate drafts,
  and runtime data remain ignored. No dependency directory is included.
- Existing Git author names and email addresses remain in history. The review
  did not rewrite authorship or existing commits.
- Challenge solutions and authoring drafts are intentionally public source.
  Keeping them off the deployed HTTP routes does not hide them from readers
  of this repository.

## Changes made

- Ignore environment variants, private-key containers, mail folders, local
  databases, and backups while retaining sanitized environment examples.
- Limit the test workflow's token permissions to reading repository contents.
- Add contribution instructions and a private security-reporting procedure.
- Correct privacy documentation about host logs, the optional video embed,
  account-export contents, and mail-file retention after account deletion.
- Document the exact static-deployment file set so operators do not serve an
  entire checkout, its Git metadata, or runtime account data through nginx.
- Refresh stale TODO claims and link the independent bug-sweep results.

## Validation

`npm test` and `node tools/sweep.mjs --accounts --flows-only` pass. The complete
account and static browser sweeps passed during the preceding bug sweep; no
application behavior was changed during this hygiene pass. Course lint remains
at zero hard errors and five settled advisories. Git whitespace checks pass,
and ignore checks confirm local secrets are excluded while examples remain
trackable.

Real SMTP submission, screen-reader speech, and physical-phone keyboard checks
remain in TODO.md. Publishing the source does not complete those checks. No
remote push or repository visibility change is part of this local review.
