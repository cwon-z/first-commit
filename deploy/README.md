# Deploying first-commit

Example configuration for running the course behind a reverse proxy, with the
optional accounts backend. These are sanitised copies of a working deployment —
addresses and paths are placeholders, so read them as a shape to copy rather
than files to drop in.

Nothing here is required. `npm start` on a single host is a complete deployment,
and the course is identical either way. Reach for this when you want the static
course served by something sturdier than one Node process.

## The shape

```
internet → reverse proxy (TLS)
              │
              ▼
           lb  (nginx)
              ├── /api/  → app  (Node, accounts + progress)
              └── /      → web  (nginx ×2, the static course)
```

`web` serves the course files and knows nothing about accounts. `app` is the
optional backend and serves only `/api/`. `lb` is the single port your reverse
proxy talks to, and decides which of the two answers.

Splitting it this way means the static course keeps being served by nginx —
including while the backend is restarting, or if you never run one at all.

## Files

| File | Copy to | Purpose |
|---|---|---|
| `docker-compose.example.yml` | `docker-compose.yml` | the three services |
| `nginx.example.conf` | `nginx.conf` | static file serving, for `web` |
| `lb.example.conf` | `lb.conf` | routing and client IP, for `lb` |
| `app.env.example` | `app.env` | backend configuration — **never commit** |

Expected layout on the host:

```
/srv/first-commit/
├── docker-compose.yml
├── nginx.conf
├── lb.conf
├── app.env          # chmod 600 — holds the SMTP credential
├── html/            # the repository's static files
├── app/             # server/ + content/ + package.json
└── data/            # the JSON store, created on first run
```

`html/` and `app/` are both copies of parts of this repository. There is no
build step; `rsync` is the whole deployment.

Set `LAN_IP` and `VPN_IP` in the environment (or a `.env` file beside the
compose file) to the private addresses you want the lb to listen on. Binding to
specific addresses rather than `0.0.0.0` is deliberate — see the warning below.

## Running static-only

Delete the `app` service from the compose file and the `location /api/` block
from `lb.conf`. The course works unchanged; progress is kept per browser in
`localStorage`, and the sign-in control never appears.

## The client IP problem, if you are behind Cloudflare

This is the part worth reading even if you use none of these files.

The backend rate-limits sign-ups, sign-ins and password resets per client IP.
Behind a Cloudflare Tunnel, the header those limits depend on does not contain
what you would expect:

```
X-Forwarded-For: 172.18.0.3     ← the cloudflared container. Every visitor.
CF-Connecting-IP: 203.0.113.9   ← the actual visitor
```

`cloudflared` forwards no `X-Forwarded-For`, so the first proxy that appends to
it contributes its own peer, and the visitor's address never appears at all.
Every learner then shares one rate-limit bucket: one attacker trips the limit
and locks out everybody, and no value of `FC_TRUST_PROXY` can fix it, because
the header is already wrong when it arrives.

`lb.conf` handles it:

```nginx
map $http_cf_connecting_ip $fc_client_ip {
    ""      $proxy_add_x_forwarded_for;   # no Cloudflare: the normal chain
    default $http_cf_connecting_ip;       # Cloudflare: the real visitor
}
...
proxy_set_header X-Forwarded-For $fc_client_ip;
```

With one entry arriving, `FC_TRUST_PROXY=1` is then correct.

**This trusts a header, so it is only safe while the lb cannot be reached
directly.** Anyone who can talk to it without passing through Cloudflare can
set `CF-Connecting-IP` to anything and take somebody else's rate-limit bucket
with them. That is why the compose file binds to private addresses instead of
`0.0.0.0`. If you expose the lb publicly, drop the `map` and use
`$proxy_add_x_forwarded_for` alone.

Verify rather than assume — put this in `lb.conf` temporarily:

```nginx
location = /cip { default_type text/plain; return 200 "$fc_client_ip\n"; }
```

then compare what it returns over your public URL against your own address from
any "what is my IP" service. Remove it afterwards.

## Reverse proxy

The lb expects to be handed everything for the hostname; it does its own
routing. In Caddy that is the whole configuration:

```caddyfile
course.example.com {
    reverse_proxy 10.0.0.5:8084
}
```

If your proxy terminates TLS (it should), keep `FC_SECURE_COOKIES=1`.

## Mail

Verification and reset links are useless if the mail does not arrive. Two
things catch people out:

- **Sending as your own domain requires SPF and DKIM that align with it.** A
  relay that signs as its own domain will fail DMARC if yours is set to reject.
- **If your relay restricts which addresses you may send as**, `FC_MAIL_FROM`
  must match exactly, or every message is refused.

Leave `FC_SMTP_URL` unset and mail is written to `data/outbox/` instead. That is
a reasonable place to start; it is not a place to finish if strangers can sign
up, because `FC_REQUIRE_VERIFICATION=1` then blocks progress for everyone.

## Backups

`data/first-commit.json` is the entire state — accounts, progress, sessions.
It is written atomically, so copying it while the server runs is safe. Nothing
else in this deployment holds anything you cannot rebuild from the repository.
