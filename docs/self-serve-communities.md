# Self-serve communities

Anyone with an account can start a community of their own: they pick a name (`acme`), the server makes
`acme.<your domain>` with them as its owner, and the app opens it. No operator is involved per community.

It is **off unless you turn it on**, and everything an operator would be trusted for is bounded instead.

## Turning it on

```bash
RELAY_OPERATOR_API_ORIGIN=https://creaton.example        # the origin signed requests are checked against
BUZZ_SELF_SERVE_COMMUNITY_DOMAIN=creaton.example         # `acme` becomes acme.creaton.example
BUZZ_SELF_SERVE_MAX_PER_HOUR=30                          # optional: creations per hour, whole deployment
BUZZ_MAX_COMMUNITIES_PER_OWNER=50                        # optional: communities one person may own
```

Setting the domain without the origin is a startup error. For a local run use `localhost:3000` for both: browsers send
`*.localhost` to your own machine, so `acme.localhost:3000` works with no DNS.

**What hosting needs (yours to arrange):** a wildcard DNS record and a wildcard TLS certificate for
`*.creaton.example`, pointing at the relay. The app itself is served from one address; if that is not the relay's own
origin, build it with `VITE_COMMUNITY_API_ORIGIN=https://creaton.example` so the create request is signed for the right
place.

## What the server guarantees

| | |
|---|---|
| Who may ask | Anyone who can sign (NIP-98). The request is checked against `RELAY_OPERATOR_API_ORIGIN`, never the inbound `Host`, and its id is recorded so a captured request cannot be sent again. |
| What they can choose | The name, and who may join (below). The host is always `<name>.<your domain>`. Names are 3 to 32 lower-case letters, numbers and hyphens, with no hyphen at the ends or as the third and fourth characters, and not one of about 60 reserved words (`login`, `www`, `admin`, `support`, …). |
| What it can overwrite | Nothing. It shares the operator path's one transaction (host row, owner row, per-owner limit) and refuses an existing host, so a create race can never hand an existing community to a new owner. |
| How much | 20 attempts per key per hour (a taken name counts), `BUZZ_SELF_SERVE_MAX_PER_HOUR` creations per hour across the deployment (a key costs nothing to make, so this is what stops a script), and the per-owner limit. All in memory per server process. |
| What the creator sees | The new community publishes its member list straight away, so the creator's own app recognises them as the owner and owner-only actions (setting up a team) work. |

Routes: `GET /self-serve/communities` says whether it is offered and under which domain (the app uses it to show or
hide **Create a community**); `POST /self-serve/communities` with `{"name": "acme"}` creates.

## Who may join

Each community decides for itself whether people must be members to read or write in it. **A new community is
invite-only unless its creator asks for `open`**: `{"name": "acme", "access": "open"}`. Any other word is refused, and
nothing is created. Because it is set when the community is made, there is never a moment in which a private community
is open to strangers.

- **Invite-only** means the same thing it does on a server that sets `BUZZ_REQUIRE_RELAY_MEMBERSHIP`: only people on
  the member list get in, over the live connection, HTTP, git and audio alike. People join with an invite link the
  owner or an admin makes (`POST /api/invites`, claimed at `/invite/<code>`).
- **The owner can change it later** with a signed `kind:9034` command carrying `["access", "open"]` or
  `["access", "invite_only"]`. Only the owner may; an admin cannot. Closing a community takes effect on the next
  request, and **also cuts off strangers who are already connected** (members, and agents signed in through a member,
  stay). Opening a community drops nobody.
- **The server-wide switch still wins.** With `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true` every community is invite-only,
  whatever its own setting says.
- **Anyone can read the answer.** The community's information document (`GET /info`, or `GET /` asking for
  `application/nostr+json`) carries `"access": "open"` or `"invite_only"`, so an app can say "ask the owner for an
  invite" before someone tries to sign in. An unknown host gets no `access` field rather than a guess.
- The setting is one cached read of a few seconds per server process; changes and the final admission check bypass the
  cache, so a closing community is never reopened by a stale answer. If the setting cannot be read, the community is
  treated as closed.

## What it does not do yet

- **No names after the fact.** A community cannot be renamed or moved to a custom domain.
- **No per-community quota or billing.** The only limits are the ones above.
- **Abuse is handled by an operator**, with `buzz-admin communities archive`.
- **Identity lives in the app's own address.** The account that owns a community is saved in the browser at the address
  the app is served from, so the app should be served from one stable address.

## Checking it

```bash
cargo test -p buzz-relay --lib self_serve -- --include-ignored   # needs Postgres
cargo test -p buzz-relay --lib handlers::relay_admin -- --include-ignored --test-threads=1   # who may join (kind 9034)
scripts/web-self-serve-e2e.sh    # the real server and a real browser: create, own, set up a team, name taken
```
