# Paperclip bridge

> ## Status: deprecated as a two-way bridge
>
> The Paperclip integration has pivoted to an **on-ramp**: **one-way import**
> of Paperclip work into Buzz plus a **private desktop sandbox** (a managed
> loopback Paperclip instance opened in its own window). The relay's org events
> ([VISION_ORG.md](../VISION_ORG.md), built out per
> [docs/paperclip-parity-plan.md](paperclip-parity-plan.md)) are the system of
> record for shared org state.
>
> The standing two-way `bridge` loop in `buzz-paperclip` is **DEPRECATED** and
> scheduled for removal once native org parity covers task sync. The one-shot
> `sync` (Paperclip → Buzz import) and `apply` (Buzz → Paperclip, private
> sandbox) subcommands remain supported on that on-ramp basis, and the
> guarantees below stay accurate for them. Do not build new work on the loop.

[Paperclip](https://github.com/paperclipai/paperclip) is a self-hosted "company of AI agents": an org
chart, issues, approvals and budgets for a team of agents. This document describes how Buzz and Paperclip
work together, and the two crates that carry it:

| Crate | Direction |
|---|---|
| `crates/buzz-paperclip` | one-way import (deprecated two-way loop pending removal): projects Paperclip issues into the community as `kind:44011` task rows, and applies Buzz-authored work back to Paperclip in the private sandbox |
| `crates/buzz-community-mcp` | exposes Buzz messages and tasks as MCP tools so an externally hosted agent can take part |

## Why a bridge instead of one system

Paperclip has no Nostr or relay integration (zero references), and its data model is its own Postgres
database. Buzz has a durable, signed, searchable event log, community-scoped membership and one identity
per participant. Neither wants to become the other, and a second system of record is worse than either.

So the split is by layer:

| Layer | Owner |
|---|---|
| Identity, membership, messaging, threads, search, audit | Buzz |
| Org chart, tasks, goals, approvals, budgets | Paperclip |
| Shared durable state that everyone must see | the relay's event log |
| Bridges between the two | this pair of crates |

A per-person Paperclip can never hold shared org state: it runs one embedded Postgres per install, binds
loopback only, and `local_trusted` mode refuses a non-loopback host. Shared state therefore lives on the
relay, and Paperclip is reached through the bridge.

## Everything is outbound

Every network leg is initiated by the process that wants something: the bridge dials the relay (WebSocket)
and Paperclip (HTTP). Nothing needs an inbound port, a public hostname, or an SSRF exemption.

That is what makes an owner-hosted deployment workable with intermittent uptime. If the owner's machine is
off, work created in Buzz simply waits in the relay and is applied on the next cycle. Continuous
availability is a convenience, not a correctness requirement. (Buzz's workflow `call_webhook` action and
Paperclip's http adapter both refuse private endpoints by default, so an inbound design would need explicit
exemptions on both sides anyway.)

## One task, one row, one issue

- A task row tagged `source=paperclip` was projected *from* Paperclip. The apply direction never turns it
  back into a new issue.
- A task a community member authored in Buzz has no such tag. The bridge creates a Paperclip issue for it
  and records the binding in the shared state file.
- After binding, the projection publishes that issue's updates under the **community's own `d` tag**, not a
  new projected id, so the board keeps one row per task.

State lives in one file (`--state`) and holds the projection cursor, the per-issue publish hash, and the
Buzz-to-Paperclip bindings. It is not interchangeable between hosts.

## What the code guarantees

Both directions are covered by tests that bind the production paths. The rules worth knowing when reviewing
a change:

**Projection (Paperclip to Buzz)**

- The cursor is a **wall-clock scan start**, never `max(updatedAt)`: Paperclip filters `updatedSince` on
  `updated_at` but orders by a different expression, so a maximum-stamp cursor silently drops rows that
  share a timestamp across a page boundary. An overlap (default 120s) is subtracted, and an unparseable
  cursor forces a full scan rather than being treated as up to date.
- A read that stops at the page cap reports truncation and **does not advance the cursor**.
- An unresolved assignee is never published as a pubkey: the row omits `p` and keeps `paperclip-assignee`.
- `kind:44011` is not addressable, so a row is only published when its mapped content actually changed.

**Apply (Buzz to Paperclip)**

- Every create sets `allowDuplicate: true` and an idempotency key derived from the Buzz event id
  (`buzz:<event-id>`). Without that, Paperclip's 48-hour recent-title dedupe can answer with an unrelated
  issue's id, and Paperclip then binds the key to it permanently. A `recent_open_title` response is a hard
  failure, and the task is left unbound.
- An empty assignee is omitted, never sent as `""` (which Paperclip stores as an empty user).
- `in_progress` on an unassigned issue is rejected with `422`, so it is created as `todo` and reported.
- Retry a transport failure, `409`, `429` and `5xx`; give up on `400`, `401`, `403`, `404`, `422`. A failed
  write leaves the task unbound so the next cycle retries it.

**The loop**

- The two directions are isolated: a failing Paperclip read does not stop Buzz work from being applied, and
  vice versa.
- State is saved every cycle, so a crash costs one cycle rather than the session's cursor.
- Apply runs before projection so an issue created this cycle is projected back in the same cycle.
- A rehearsal is structurally unable to write, and shutdown finishes the cycle in flight.

**MCP tools**

- Reads always send `kinds` (the relay's p-gate rejects unscoped reads).
- A closed subscription is an error, never an empty result; an incomplete read says so.
- Limits are clamped; identity comes from `BUZZ_PRIVATE_KEY` and is never a human's.

## Running it

Keys are read from env vars (`PAPERCLIP_API_KEY`, `PAPERCLIP_WRITE_API_KEY`,
`BUZZ_PRIVATE_KEY`, …) or the matching CLI flags. **Prefer env vars over CLI
flags for keys: process listing (`ps`, `/proc`) leaks CLI arguments to every
local user, while env vars do not.**

```sh
# One cycle, cron style. --cycles 0 runs until SIGINT/SIGTERM.
buzz-paperclip bridge \
  --paperclip-url "$PAPERCLIP_BASE_URL" \
  --paperclip-api-key "$PAPERCLIP_API_KEY" \
  --write-api-key "$PAPERCLIP_WRITE_API_KEY" \
  --company "$PAPERCLIP_COMPANY_ID" \
  --relay-url "$BUZZ_RELAY_URL" --private-key "$BUZZ_PRIVATE_KEY" \
  --channel "$BUZZ_CHANNEL_ID" --assignee-map ./assignees.json \
  --state /var/lib/buzz-paperclip/state.json --cycles 1

# Rehearse the whole loop without writing.
buzz-paperclip bridge --dry-run --cycles 1 ...
```

Invite a community member (the link is posted into a channel, because Paperclip invites are copy-link only
and it emails nobody):

```sh
buzz-paperclip invite --role operator --channel "$BUZZ_CHANNEL_ID" ...   # a human
buzz-paperclip invite --agent --channel "$BUZZ_CHANNEL_ID" ...           # an agent, via the onboarding doc
```

`sync` and `apply` run one direction each. `--assignee-map` maps a Paperclip principal id to a Buzz pubkey
and is used in both directions (inverted for apply), and for author attribution, so the directions cannot
disagree about identities.

Attribution detail worth knowing: Paperclip derives `createdByUserId` from the actor, so without help every
bridged issue looks like the bridge's own work. The bridge therefore sets `responsibleUserId` from the
identity map. Paperclip validates that field **not at all** — it stored the string `not-a-real-user-id` with a
201 — so the bridge resolves it only from the map, refuses implausible values, and omits it when the author is
unmapped (Paperclip then falls back to the creating actor, which is truthful).

For the MCP server, set the same relay URL and key an agent already uses:

```sh
BUZZ_RELAY_URL=wss://relay.example BUZZ_PRIVATE_KEY=<hex> buzz-community-mcp   # stdio transport
```

## Status

Implemented and tested, but **not yet run against a live Paperclip or a live relay**: the HTTP paths are
exercised against fakes built from Paperclip's own route, validator and service source. Verified paths worth
knowing: `GET /api/companies/{id}/issues` returns a bare array; auth is `Authorization: Bearer` only (a
`viewer`-role board key is read-only and sufficient for reads); `?updatedSince=` exists but is undocumented;
there is no push channel of any kind, so polling is the only option.

Not built yet: identity provisioning (binding an npub to a Paperclip user principal), and an embedded
Paperclip view in the desktop app.

## Desktop window, and how signing in works

Paperclip's UI opens in **its own native window**, not an embedded frame. The app's CSP declares no
`frame-src`, so `frame-src` falls back to `default-src 'self'` and a frame pointing at Paperclip's origin is
refused in a packaged build. That policy is enforced only on assets Tauri itself serves, which is why neither
`just dev` nor the Playwright suite can catch it. A separate webview loads the remote origin directly, so the
policy does not apply and Paperclip gets a real browser context.

Sign-in comes with the window. Paperclip authenticates a Nostr identity with NIP-98, so the window is created
with an injected NIP-07-compatible `window.nostr` (`getPublicKey`, `signEvent`) that delegates to the `nip07`
inlined plugin — a plugin, not plain app commands, because the Paperclip webview loads a remote URL and Tauri's
ACL refuses remote invokes of app commands that no permission grants ("... not allowed. Plugin not found").
The secret key never leaves the Rust process.

The commands are granted only by `capabilities/paperclip-nip07.json`, scoped to the `paperclip` window and the
managed loopback origin; the catch-all `default` capability stays local-only.

Three bounds on that, all deliberate:

- **The signer only signs a NIP-98 authentication event.** Kind 27235, empty content, and only the `u`,
  `method`, `nonce` and `payload` tags, with `u` an http(s) URL and `method` non-empty. It cannot be used to
  post, react, or authenticate to a relay as the user. An injected `window.nostr` is a capability handed to
  whatever that webview loads, so it is narrowed to exactly what sign-in needs.
- **Only the managed loopback instance gets IPC.** Tauri grants IPC to a remote origin only when a capability
  lists it, and the capability admits `http://127.0.0.1:*` and `http://localhost:*` and nothing else. A hosted
  HTTPS instance opens without a signer, which is the conservative default: an https-wide pattern would hand
  a signing capability to any page the window later navigated to.
- **The window URL itself is checked in Rust** before the webview is built: https anywhere, or http only on
  loopback. A `file://`, `javascript:` or plain-HTTP-to-a-remote-host URL is refused.

Practical notes for a sign-in page: `window.nostr` may be absent (hosted instance, or a bracketed-IPv6-only
instance, which Tauri's URL-pattern parser cannot express), so the page must degrade rather than throw. The
shim also dispatches a `nostr:ready` event on `window` when it installs itself, which is the safe thing to
wait for. A non-loopback URL pattern for a bracketed IPv6 literal is rejected at build time by `tauri-build`,
so the limitation is caught rather than shipped.

The shim wraps command rejections in real `Error` objects before they reach the page. Tauri rejects a failed
command as a raw string (`Result<_, String>`), and a page that only formats `error instanceof Error` would
show a generic fallback instead of the actual reason — a refused origin, a recovery-mode identity, an IPC
denial. Paperclip's sign-in page does exactly that, so a raw rejection surfaced as "Nostr sign-in failed"
with no cause. Tests in `paperclip_window.rs` execute the shipped shim source against a stubbed IPC and pin
the rejection shape.

### Signing in: the exact client contract

Paperclip's Nostr sign-in is implemented with `better-auth-nostr@0.3.0` (MIT, peer `better-auth ^1.7.0`;
Paperclip pins 1.7.2). The plugin issues a one-time nonce per pubkey, verifies the NIP-98 token with
`nostr-tools/nip98` `validateEvent(event, url, "post", { nonce })`, consumes the nonce, and mints a session
through Better Auth's own `internalAdapter.createSession` + `setSessionCookie` — the same production path
Paperclip already uses for workspace handoff, so `req.actor` and everything downstream keep working.

Two details a client must get right, both of which fail as a `401` at the server rather than here:

- With a non-empty request body, `nostr-tools` makes the **`payload` tag mandatory**. The signed event must be
  kind 27235, empty content, and carry exactly `u` = `<origin>/api/auth/nostr/login` (the `/api/auth` mount is
  part of it), `method` = `POST`, `nonce` = the issued nonce, and `payload` = `sha256hex(JSON.stringify({nonce}))`.
- `created_at` must be within 60 seconds, and the header is `Nostr <base64(JSON(event))>`.

`desktop/src-tauri/src/commands/paperclip_window.rs` has a test pinned to that exact shape, so a change in
the contract breaks a test instead of sign-in.

### Practical note: this needs a Paperclip built from the fork

The Nostr plugin lives in the Paperclip **source tree**, behind `PAPERCLIP_NOSTR_AUTH_ENABLED` (default off;
off means the endpoints 404 and `GET /api/health` reports `nostrAuthSupported: false`). A Paperclip installed
from the published npm package therefore has no Nostr sign-in, and the desktop window falls back to whatever
that instance offers. Deployment has to run the fork, or the change has to go upstream.
