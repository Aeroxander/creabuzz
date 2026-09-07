# Web UI Roadmap — agent handoff plan

This document hands the Buzz web client to another agent. It assumes repo
access at `/Volumes/MicroSD/creabuzz`, branch `web-agent-fleet` (off
`web-launchpad`, which tracks upstream `block/buzz` main). Read sections 0–2
before touching code; work items in section 3 are ordered by priority.

## 0. What this is

A browser-based (local-first) web client for Buzz, a Nostr NIP-29 relay
platform. Humans and AI agents share channels, wiki, and tasks as peers
("multiplayer LLM"). The last completed pass aligned the web UI to the
desktop app: gradient wash backdrop, floating content card, desktop-grade
composer, channel-header pills, agent identity in the timeline
(`494ca0456`). This plan covers what is still missing or rough.

## 1. Environment and commands

```bash
cd /Volumes/MicroSD/creabuzz
git rev-parse --abbrev-ref HEAD        # expect: web-agent-fleet
. ./bin/activate-hermit               # REQUIRED before node/pnpm/cargo
```

Web checks (run from `web/`, after activating hermit):

```bash
pnpm typecheck          # must be clean
pnpm check              # lint + pubkey-truncation guard, must pass
pnpm build              # must print ✓ built (output feeds the relay)
pnpm test:e2e:smoke     # must be 10/10
```

Relay checks (repo root, hermit active):

```bash
cargo build -p buzz-relay
cargo test -p buzz-relay --lib ingest
```

Local stack (relay serves `web/dist`, the only server):

```bash
redis-server --daemonize yes --port 6379
set -a; . ./.env 2>/dev/null; set +a
export DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/buzz_web_test
export BUZZ_BIND_ADDR=127.0.0.1:3000 BUZZ_RELAY_URL=ws://localhost:3000
export BUZZ_RELAY_PRIVATE_KEY=$(openssl rand -hex 32)
export BUZZ_WEB_DIR=./web/dist BUZZ_WEB_SPA=full BUZZ_P2P_SIGNALING=1
# LLM gateway (browser agents call the model through the relay; the browser
# never sees the key). Values live in gitignored `.env`, never in git.
# export BUZZ_LLM_PROXY_URL=https://api.code.umans.ai/v1/chat/completions
# export BUZZ_LLM_API_KEY=<redacted>
nohup ./target/debug/buzz-relay >/tmp/relay.log 2>&1 &
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/health
```

App URLs: landing `http://127.0.0.1:3000/`, community
`http://127.0.0.1:3000/c/127.0.0.1%3A3000`.

Commit every logical unit with `git commit -s` (DCO sign-off is CI-enforced).
Delete stray artifacts (`dump.rdb`) before committing.

## 2. Hard-won rules (violating these burns hours)

1. **Relay scoping invariant.** Any event carrying an `h` tag that resolves to
   a channel is stored channel-scoped and live-fanned ONLY to subscriptions
   registered under that channel. Community-global kind-only subscriptions
   never receive channel events, and vice versa. REQ history queries return
   both. Consequence: live pumps for kinds that may carry `h` (fleet tasks
   kind 44011) must subscribe per-channel (`kinds` + `#h` per id) AND global
   (kinds only), then route client-side. `#p` tag filters do not fan out —
   match assignee (`p` tag) in code.
2. **History replay.** A live REQ without `since` replays channel history
   into the pump. Mention pumps must be `since`-scoped (or old `@buzz-tab:`
   messages get re-captured as tasks on every page load). The task pump is
   kinds-only with NO `since` (`since` suppressed its live delivery on this
   relay); it dedupes with a processed-ids set instead.
3. **One agent service per browser origin.** Agent identity (`buzz.agent.nsec`)
   persists per origin, so every tab would otherwise run a worker for the
   same key. `browser-agent.ts` holds a Web Locks (`"buzz-agent"`) singleton;
   keep it. Related: stray Chromium processes from dead Playwright runs keep
   heartbeating (kind 44010) and answering mentions — kill them
   (`pkill -f chrome-linux`) before deterministic agent tests, and expect the
   user's real browser tabs to join the fleet.
4. **Kinds registry.** 44010 capabilities, 44011 tasks, 44001 wiki pages,
   40002 agent turns, 20000–29999 ephemeral (anonymous use needs
   `BUZZ_P2P_SIGNALING=1`). Only 30000–39999 are storage-addressable;
   everything else is read-side LWW — dedupe client-side by `d` keeping the
   newest `created_at`. Any pubkey may publish an update row under the same
   `d`; there is no owner check for non-NIP-33 kinds.
5. **Port discipline.** Web smoke uses vite preview on :4173
   (`reuseExistingServer`). Never run anything else on :4173 (a desktop
   preview server once shadowed it and broke smoke with unrelated errors).
   Check `lsof -nP -iTCP:4173` when smoke fails mysteriously.
6. **Heartbeat units.** Agent `heartbeat` fields are unix SECONDS;
   `Date.now()` is ms — normalize before comparing (fixed once already in
   `use-agent-roster.ts`; don't regress).
7. **Silent no-op edits.** Biome reformats on save; exact-string replacements
   can silently miss. Always re-grep after editing.
8. **Pubkey display.** Never hand-roll `pubkey.slice(...)` — use
   `truncatePubkey` from `shared/lib/pubkey` (a CI guard enforces this).
9. **Test DB is polluted.** `buzz_web_test` holds leaked-agent rows (dozens
   of `buzz-tab` capabilities, `Assigned`-forever test tasks, junk turns).
   Prefer fresh markers per test run; do not delete rows without asking.
10. **Vision.** If your model supports images, capture with Playwright and
    load via the `attach_image` skill, then look before/after every visual
    change. Without vision, use DOM probes + pixel sampling (PIL) as fallback.

## 3. Work items (in priority order)

### A. Mobile / responsive layout — P0 usability, currently unusable
- **Problem.** The sidebar is a fixed 240px column; at 390px width it eats
  62% of the screen and the content pane is an unreadable sliver
  (`/tmp/buzz-ui-shots/ux-05-mobile.png` showed this state).
- **Scope.** Collapsible sidebar (hamburger in the channel header on narrow
  screens), channel list as slide-over, full-width timeline/composer/wiki/
  fleet; keep desktop layout ≥1024px untouched.
- **Files.** `web/src/features/channels/ui/CommunityShell.tsx`,
  `ChannelSidebar.tsx`, `ChannelTimeline.tsx`, `Composer.tsx`,
  `features/wiki/ui/WikiView.tsx`, `features/fleet/ui/FleetView.tsx`.
- **Accept.** Screenshots at 390×844 for landing/community/channel/wiki/fleet
  with no sliver layout; desktop screenshots unchanged; smoke green.

### B. Onboarding + account layer (Pass A) — P1 completeness
- **Problem.** Identity is silently generated; the sidebar user chip is a dead
  button; there is no create/import/backup/profile flow ("where do I create
  an account?").
- **Scope.**
  1. First-run onboarding (only when no `buzz.identity.nsec` exists):
     create key → display name + avatar → backup step showing the nsec plus
     a password-encrypted backup download (AES-GCM, in-browser; nothing
     touches the server), plus import-existing-nsec path.
  2. User-chip popover: edit kind-0 profile (name/picture/about → publish
     kind 0), export nsec, import, reset (rotate). `identity.ts` already
     exports `importIdentity`/`rotateIdentity`; `alert-dialog.tsx` exists
     for destructive confirms.
- **Files.** New `web/src/features/onboarding/*`, `CommunityShell.tsx`
  (`UserChip`), `features/profiles/*`.
- **Accept.** Fresh profile → onboarding → chosen name renders in timeline;
  backup downloads; import restores identity; existing users never see
  onboarding.

### C. Repositories dead-end — P1 navigation
- **Problem.** The landing "Repositories" button routes to `/repos`, which is
  a stub redirecting to `/`. It goes nowhere.
- **Scope.** Either remove the button, or wire the existing
  `features/repos` UI (detail pages exist) to real routes. Do not leave a
  dead button.
- **Accept.** Button gone, or repo list → detail navigation works live.

### D. Wiki consolidation — P2 polish
- **Problem.** Two stacked toolbar rows eat space; Save floats disconnected
  at the bottom of empty gray; no dirty indicator; no page search/rename/
  delete; stale demo content in `home`.
- **Scope.** Merge mode switcher + formatting into one row; dirty dot and
  disabled Save when clean; page-list search; rename/delete with
  `alert-dialog` confirm (define delete as a kind-5 or empty-content
  convention and document the choice); replace demo content with a real
  welcome page.
- **Files.** `features/wiki/ui/WikiView.tsx`, `WikiEditor.tsx`,
  `use-wiki-pages.ts`.
- **Accept.** Screenshots before/after; all wiki smoke paths green.

### E. Multiplayer feel: presence + memory — next after A–D
1. **Channel header "N agents online"** via the existing `useAgentRoster`
   hook (wire into `ChannelTimeline` header).
2. **Ephemeral "working…" indicator.** Agent publishes kind 20002 (typing)
   or a dedicated 24xxx ephemeral with the channel tag while processing;
   timeline subscribes per channel and shows "buzz-tab is working…".
3. **Agent memory.** `KIND_AGENT_ENGRAM` (30174, NIP-AE/NIP-44 encrypted)
   exists on the relay. Agent loads recent engrams into its prompt context;
   add a memory viewer to FleetView.
4. **Mentions from wiki editor + thread replies**, with the page/thread as
   the agent's context.
- **Accept for each.** Live two-tab or agent-flow verification + screenshots;
  no new servers.

### F. Sandbox runner — needs operator decisions first
- Prime-agent in ACP mode on the relay host as the always-on fleet worker
  subscribed to a fleet channel; the LLM key gateway
  (`POST /llm/chat/completions`, NIP-98) already exists. Blocked on:
  `BUZZ_LLM_*` endpoint choice and server-side agent key management.
- Do not start without those answers.

### G. Settings surface — later
- Appearance/theme, P2P toggle, gateway status, relay directory management.
  Identity backup overlaps item B — build it there, not twice.

## 4. Verification standard (every item)

1. `pnpm typecheck`, `pnpm check`, `pnpm build`, `pnpm test:e2e:smoke`
   (expect 10/10) from `web/` with hermit active.
2. `cargo build -p buzz-relay` (+ lib tests) if the relay is touched.
3. Live Playwright verification against the local relay (`buzz_web_test`);
   attach before/after screenshots for anything visual.
4. Small logical commits with `git commit -s`; tree clean (`git status`
   empty apart from intended files).

## 5. Map of the relevant code

- `web/src/app/routes/` — root (gradient is painted on `<body>`; do not use
  fixed negative-z-index layers, they composite above content), index,
  `c.$host`, repos stubs.
- `web/src/features/channels/ui/` — `CommunityShell` (shell + card),
  `ChannelSidebar` (collapsible), `ChannelTimeline` (header pills, per-event
  identity via ThreadTree maps), `Composer` (desktop-style card).
- `web/src/features/fleet/` — `browser-agent.ts` (service, locks, pumps),
  `use-agent-roster.ts`, `use-agent-tasks.ts`, `ui/FleetView.tsx`.
- `web/src/features/wiki/` — pages hook + views + TipTap editor.
- `web/src/features/profiles/` — kind-0 lookup; `shared/ui/` — ported
  desktop primitives (`UserAvatar`, `badge`, `PageHeader`, `alert-dialog`);
  `shared/lib/` — identity, agent-identity, publish, NIP-98, pubkey.
- `crates/buzz-relay/src/api/llm_gateway.rs` — key gateway;
  `handlers/{req,ingest}.rs`, `subscription.rs` — fan-out scoping;
  `crates/buzz-core/src/kind.rs` — kind registry.
- Reference design: `desktop/` (React 19 + TanStack Router; harvest UI +
  relay-client logic, never Tauri shell code). Its e2e mock bridge builds
  with `pnpm build:e2e`; `react-day-picker` must be installed for it.
