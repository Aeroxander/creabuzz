# Web Integration Plan — Flotilla · Prime Agent · OpenKnowledge

Status: proposal (2026-09-05, branch `web-launchpad`)
Previous plan: `docs/web-client-plan.md` (dao-launchpad) — superseded by this
doc for the three-track structure; phase goals for discovery/read/write parity
carry over.

## Constraints (fixed)

1. **No Node.js services.** Nothing we operate runs Node. The relay (Rust) is
   the only server. Everything else is local-first in the browser.
2. **Local-first storage.** op-sqlite web (OPFS-backed SQLite-WASM in a
   worker) is the chosen browser DB; IndexedDB/OPFS primitives for blob/CRDT
   state. Validated in Phase 0 before wide adoption.
3. **Source of truth = the relay data plane.** Browser state is a cache;
   durable data lives as Nostr events / git repos on the relay.
4. **Discovery first.** A visitor with no identity browses communities; an
   account is created only at join/start time.
5. **License boundary.** OpenKnowledge is GPLv3 → blueprint + MIT-compatible
   deps only; never vendored code. Buzz is Apache-2.0.

## Two data planes

- **Canonical plane = the relay** (Nostr events + git): durable, auditable,
  async. Messages, membership, identities, wiki snapshots, agent turns, repos.
  P2P never replaces this.
- **Live plane = WebRTC peer-to-peer via [Trystero](https://github.com/dmotz/trystero)**
  (MIT, TypeScript, browser-only): ephemeral, co-present, low-latency, zero
  relay load. Peer discovery/signaling rides the Buzz relay itself (Trystero's
  Nostr strategy — the relay only sees tiny SDP handshakes; payloads go
  peer-to-peer, end-to-end encrypted). Trystero also ships chunked large
  transfers with progress and React hooks.

Feature routing: chat = relay only · wiki = relay snapshots + P2P deltas ·
presence/typing/cursors = P2P only · media = Blossom canonical + P2P transport.

Caveats: (a) a lone editor or same-device multi-tab has no peer — the wiki
provider always persists snapshots on save, so relay-land stays in sync;
(b) pin the Nostr strategy to the community relay — never the default public
BitTorrent rendezvous; (c) enterprise NAT may need a TURN server (UDP infra on
the relay host — not Node, but new ops surface; defer until needed).

## One-time shared foundation (Phase 0 — gates everything)

- SPA fallback for every client route (equivalent of upstream `BUZZ_WEB_SPA=full`).
- Relay sends `Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp` on SPA responses (op-sqlite OPFS requirement).
- Storage + peer spike in the Vite app: op-sqlite web (open/insert/select/
  FTS5, worker+wasm packaging, reload persistence) **and a Trystero
  browser-to-browser round-trip with Nostr signaling through the community
  relay** (currently blocked by npm network; retry on this branch).
- Web-native client core: WS + HTTP bridge, typed errors (fail-closed —
  keep the relay-URL fix from dao-launchpad `95eef0701`, cherry-pick into
  web-launchpad), identity interface (ephemeral / NIP-07 / passkey / nsec).
- CI: web typecheck + unit + smoke in `just ci`.

---

## Track 1 — Flotilla model: community discovery + join gating  (N1)

**What Flotilla is:** a Discord-like Nostr client, "relays as groups". It is
*already* browser/local-first (IndexedDB via `idb`, localStorage, Svelte PWA;
no server of its own). Spaces = relays; join gating via invite codes;
membership via relay-list rooms + member kinds.

**Conversion needed: none for local-first** (already browser). Conversion is
*model adoption* — we do not port Svelte code; we take its discovery and
gating shape into the React client with Buzz-native primitives.

- Directory: unauthenticated `GET /communities` (name, description, icon,
  member count from kind:39000 + NIP-11 fields) + cross-deployment aggregation
  via `VITE_COMMUNITY_DIRECTORIES` (the equivalent of Flotilla's space browse
  / default-relay list, but for public communities).
- Landing `/`: community directory grid → public community page `/c/<host>`
  (metadata, member count, "Join" / "Open in app") — zero identity friction.
- Join gating: invite codes + join policy (existing Buzz invite/join-policy
  plumbing; mirrors Flotilla's "space requires an invite code").
- Membership: kind:39002 writes on join/leave; "my communities" persisted
  browser-local; membership changes read back via relay.
- "Start a community" CTA → identity creation → community wizard.

**Exit:** fresh visitor: directory → community → join prompt → identity
created only at the gate. e2e for the whole path.

## Track 2 — Prime Agent as the default agent (web UI + relay-hosted execution)

**What it is:** Node CLI with ACP mode (`prime-agent --mode acp`, JSON-RPC
over stdio), a TS SDK, and a local daemon (isolated per-session processes,
global agent-message delivery, `rlm()` child agents). Cannot run in a browser.

**Conversion: move execution to the relay host** — the single Node process in
the system lives beside the relay (matches "except the relay"). Browser gets
a pure UI over relay events.

1. Relay wiring (`buzz-acp`): spawn command → `prime-agent --mode acp`;
   inject `BUZZ_RELAY_URL`/`BUZZ_PRIVATE_KEY`/auth env (harness already does
   this); attach MCP servers via `session/new.mcpServers` (buzz-dev-mcp; later
   wiki tools from Track 3).
2. Web UI: agent list/invoke/watch-turn/cancel on existing agent kinds
   (40002/45001/45003, working signal, turn history); mention → agent.
3. Multiplayer / shared company context: agent turns + summaries publish
   context events on the relay (no daemon in browser); browser caches in
   op-sqlite; shared brain = wiki (Track 3), which agents read/write through
   the same relay data plane — no MCP server to host. Connected viewers may
   stream live turn deltas over the Trystero peer plane (optional, later).
4. Optional local-first fallback: buzz CLI + desktop already run managed
   agents against `BUZZ_RELAY_URL`; the same pattern lets an operator run
   prime-agent on their own machine.

**Exit:** web user mentions an agent → relay-hosted prime-agent turn →
thread renders; two agents in one community converge using shared wiki pages.

## Track 3 — OpenKnowledge model: local-first wiki + knowledge graph

**What it is:** WYSIWYG markdown LLM wiki (TipTap/CodeMirror, Yjs CRDT,
Hocuspocus server for sync, git-backed storage, Orama search, MCP for agents).
GPLv3 + a Node server → cannot run as-is.

**Conversion: rebuild the *model* in-browser** using MIT components, with the
relay as the transport (no Hocuspocus server, no git server beyond Buzz's).

- Editor: TipTap (MIT) WYSIWYG + CodeMirror (MIT) source mode.
- Local storage: pages/attrs/graph edges in op-sqlite web; FTS5 for local
  search (verify in wasm build; fallback: in-memory search index).
- Sync without a server, hybrid: **Yjs update deltas over Trystero**
  (live co-editing P2P, relay signaling only) + **periodic snapshots as
  addressable events on the relay** (NIP-33) for durability and late joiners.
  No Hocuspocus, no delta flood through the relay.
- Durability: browser→relay git push via **isomorphic-git** (already a dep)
  to Buzz repo storage (relay git smart HTTP + git-credential-nostr) = the
  "team sharing / backup" story, with no Node.
- Knowledge graph: link/mention edges extracted on write → op-sqlite; browser
  graph view (MIT licensed renderer); queries over the local DB.
- Agent access: wiki is relay-native (events + git) → Track 2 agents query it
  directly; no separate MCP service.

**Exit:** two users co-edit a page live (Yjs P2P deltas, relay signaling +
snapshots); graph view renders links/mentions; an agent writes a wiki entry
from chat context.

---

## Sequencing

```
Phase 0 (shared foundation) ────────┬──────────► Track 1 (discovery, N1)
                                    ├──────────► Track 2 (agent relay wiring + UI)
                                    └──────────► Track 3 (editor + local storage,
                                                 then sync provider, then graph,
                                                 then agent wiki integration)
```
- Track 1 needs only Phase 0. Tracks 2 and 3 are independent of each other
  except the final "agent wiki" step (Track 3.5) which needs both.
- Each track is its own PR series on `web-launchpad`; each ships behind the
  same e2e gates.

## Risks

- **op-sqlite web** (worker/wasm packaging in Vite, COOP/COEP in the relay,
  FTS5 availability) — proves or disqualifies in the Phase 0 spike.
- **GPL boundary (OK)** — blueprint-only; automated license audit in CI for
  all new deps.
- **One Node process** — prime-agent runs on the relay host (or an
  operator's machine via buzz CLI). Confirm this is acceptable; everything
  else is browser + Rust.
- **Kind interop vs Flotilla** — Flotilla's RELAY_* join kinds are
  Flotilla-specific; Buzz joins use native invite/join-policy + 39002. Do not
  copy Flotilla kinds.
- **Scope** — read/write parity phases from the previous plan stay the
  backbone; these three tracks are the differentiation layer, not a
  replacement for channels/chat parity.
