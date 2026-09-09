# Security reports

Please do not post credentials, account data, reset links, or details of an
unpatched exploitable vulnerability in a public issue or pull request.

Use private vulnerability reporting from this repository's Security tab if it
is enabled. If it is unavailable, open an issue asking the maintainer for a
private reporting channel without including exploit details or sensitive data.

Include the affected commit, configuration, reproduction steps using disposable
accounts, and expected versus actual behavior. There is no guaranteed response
time or separate maintenance policy for older versions.

For self-hosting, read the README's public deployment configuration. Set owner
addresses before exposing registration, configure proxy trust for the actual
network, and use secure cookies behind HTTPS. Never serve the accounts data or
local mail directory as static files. Repository visibility and deploying a
public accounts service are separate decisions; the outstanding manual checks
are recorded in TODO.md.
