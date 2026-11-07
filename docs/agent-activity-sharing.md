# Agent Activity Sharing — Design Contract

> Status: Phase 0 design. Implements the "shared visibility" thread:
> member-visible agent activity with opt-in sharing, relay as enforcer.
>
> Grounding: `VISION_ACTIVITY.md` (verb→object→outcome, render classes),
> `VISION.md` (channel membership is the only gate), `ARCHITECTURE.md`
> (REQ checks access before subscribing), `docs/paperclip-prime-bridge.md`
> (Paperclip enforces, Buzz renders), `docs/nips/NIP-AM.md` (44200 metrics).

---

## 1. Problem

All rich "what is it doing" signal (tools, files, plans, spend) is
owner-only: NIP-44 observer frames (24200) to the owner, p-gated turn
metrics (44200) to the owner, Paperclip runs behind its own auth. Channel
members see posted messages plus a working dot. A multiplayer agentic
Slack needs member-visible activity without breaking the owner-only
guarantees that exist today.

Decision: **opt-in sharing, off by default, relay-enforced.**
No UI may render member-visible activity that the relay did not authorize;
no grant may widen what the owner sees narrowed.

## 2. What ships in v1 (this branch)

**A real `agent_activity` feed** — no new kinds, no ingest changes, no
crypto changes:

- Agent-plane kinds in visible channels (agent-authored by construction):
  `44010` capabilities, `44011` tasks, job `43001/43002/43003`,
  workflow lifecycle `46001/46005/46006` (triggered/completed/failed —
  step noise excluded like `activity` excludes 46001–46012).
- The requester's **own** `44200` turn metrics (existing p-gate preserved).
- Membership enforcement reuses the proven
  `push_visible_channel_filter` + community fence. Empty accessible list
  means global-only, never all channels.

`buzz feed get --types agent_activity` and the desktop rail read this.
Removing the kind allowlist must turn the distinct-feed test red
(falsifiable guard); removing the p-gate must turn the cross-owner test
red.

## 3. Phase 3 (designed here, not built yet): share grants

### 3.1 Grant kind

`KIND_AGENT_ACTIVITY_GRANT = 44012` (fleet range 44010–44019, next free).
Addressable (NIP-33), `d = "activity-share:<agent-hex>:<channel-uuid>"`.

- Content JSON: `{ "classes": ["lifecycle", "spend", "tasks"], "revoked": false }`.
  Replacement semantics: latest addressable row wins; `revoked: true` (or
  NIP-09 deletion) removes the grant.
- Tags: `["p", <agent-hex>]`, `["h", <channel-uuid>]` (channel scope, so
  existing membership checks apply to the grant event itself).

### 3.2 Write-path authorization (relay ingest)

A grant is accepted only when the signer is:

1. the agent itself (`event.pubkey == p tag`), or
2. a channel owner/admin of the `h` channel, or
3. the agent's registered owner via NIP-OA attestation (same path as
   `buzz-acp` owner resolution).

Anything else → rejected like any unauthorized write. A member cannot
grant-away another agent's spend visibility (spoofing fails closed).

### 3.3 Read-path enforcement

- `agent_activity` additionally returns granted classes: `spend` unlocks
  the agent's `44200` rows to channel members; `lifecycle`/`tasks` unlock
  fleet rows already visible (documents intent for the live projection).
- REQ handlers check the grant **before** registering the subscription
  (same ordering as channel access today). Revocation re-checks live
  subscriptions; a revoked grant stops delivery without closing the
  underlying channel subscription.
- Feed queries join the latest grant row per (agent, channel); the join is
  community-fenced like everything else.

### 3.4 Live projection (ephemeral, follow-up)

Observer frames (24200) are ephemeral and never stored, so grants cannot
make them historical. The follow-up projects redacted lifecycle frames
(no secrets, no raw env, bounded, `h`-scoped) to granted members over the
existing fan-out path. Out of scope for v1; this doc reserves the shape.

## 4. Render contract (VISION_ACTIVITY.md)

Member-visible rows render the same twelve classes with the same rules:
semantics over transport, outcome-first, mutate-in-place, never-go-dark,
failures rise / reads recede, resolve references, coalesce streams,
honesty over guessing, polished by default with a raw rail on demand.
Owner-only rows never degrade into member rows — absence of a grant is a
rendered empty state, not a silent hole.

## 5. Acceptance

| # | Guard | Proof |
|---|---|---|
| 1 | Distinct feed | `agent_activity` returns agent-plane rows `activity` omits and omits human chatter `activity` returns |
| 2 | Community fence | Community B rows never appear in community A feed |
| 3 | p-gate | Another owner's 44200 never appears in my `agent_activity` |
| 4 | Empty-means-global | Empty accessible list returns globals only |
| 5 | Limit cap | `FEED_MAX_LIMIT` enforced regardless of caller limit |
| 6 | Grant write auth (Phase 3) | Member-signed grant for another agent rejected |
| 7 | Grant revocation (Phase 3) | Revoked grant stops delivery, channel subscription survives |
