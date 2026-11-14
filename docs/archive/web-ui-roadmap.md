# Web UI Roadmap — handoff plan

This document hands the Buzz web client to another agent. It assumes repo
access at `/Volumes/MicroSD/creabuzz`. Sections 0–2 are context you need before
touching code; section 3 is the state of the work (what landed, what is open).

## 0. What this is

A browser-based web client for Buzz, a Nostr NIP-29 relay platform. Humans and
AI agents share channels, wiki, and tasks as peers ("multiplayer LLM").

**Status (last updated by the web production-readiness pass, 60 commits on
`dao-launchpad-rewrite`).** The client is feature-complete against this
document's original plan: channels and a live timeline, threads, reactions,
edits/deletes, the community directory and invite landing, wiki with live
co-editing, the agent fleet including the in-tab agent, the work board,
notifications, search, profiles, repositories, and the DAO launchpad. It builds
clean, passes its gates (68 unit tests, 90+ browser tests, bundle and a11y
budgets), and has been run against a real relay (see §4).

## 1. Environment and commands

```bash
cd /Volumes/MicroSD/creabuzz
. ./bin/activate-hermit               # REQUIRED before node/pnpm/cargo
```

Web checks (run from `web/`, after activating hermit):

```bash
pnpm typecheck          # must be clean
pnpm check              # biome + pubkey-truncation + px-text guards
pnpm check:file-sizes   # per-surface file-size ratchet
pnpm build              # must print ✓ built (output feeds the relay)
pnpm check:bundle-size  # first-load budget; needs a build. Also fails on any
                        # .js in the dist root (the relay serves only /assets/*)
pnpm test               # node:test unit tests, no browser or relay (68)
pnpm test:e2e:smoke     # build + playwright suite, mocked relay (90+)
pnpm test:e2e:real      # built client against a real relay; see
                        # web/tests/e2e-real/README.md for the one-time setup
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
   keep it.
4. **Kinds registry.** 44010 capabilities, 44011 tasks, 44001 wiki pages,
   40002 agent turns, 20000–29999 ephemeral (anonymous use needs
   `BUZZ_P2P_SIGNALING=1`). Only 30000–39999 are storage-addressable;
   everything else is read-side LWW — dedupe client-side by `d` keeping the
   newest `created_at`. Any pubkey may publish an update row under the same
   `d`; there is no owner check for non-NIP-33 kinds.
5. **Port discipline.** Web smoke uses vite preview on :4173
   (`reuseExistingServer` outside CI). Never run anything else on :4173.
   Check `lsof -nP -iTCP:4173` when smoke fails mysteriously, and remember the
   preview serves the last **built** bundle: `pnpm build` first.
6. **Heartbeat units.** Agent `heartbeat` fields are unix SECONDS;
   `Date.now()` is ms — normalize before comparing.
7. **Silent no-op edits.** Biome reformats on save; exact-string replacements
   can silently miss. Always re-grep after editing — and **never run
   `biome check --write` on a file whose parse is already broken**: it rewrites
   whole regions and destroys the file. Restore from git and redo the edits in
   one atomic pass instead.
8. **Pubkey display.** Never hand-roll `pubkey.slice(...)` — use
   `truncatePubkey` from `shared/lib/pubkey` (a CI guard enforces this).
9. **The relay serves only `/assets/*` from the web directory.** Every other
   path is answered with the SPA shell, so a script placed in the dist root is
   served as HTML and never runs (this broke the theme bootstrap in production
   while every mocked suite passed). `check:bundle-size` now fails on it.
10. **A read that does not complete is a failure, not an empty result.** The
    one-shot client resolves only on EOSE; a socket close before it rejects.
    Surfaces must render `shared/ui/query-error` rather than their own empty
    state, or a broken relay reads as "nothing here" (see the channel timeline,
    wiki list, board, fleet, launchpad, search).
11. **The relay authorizes a REQ against the authenticated identity.** A
    subscription sent before the NIP-42 handshake finishes is closed with
    `restricted: p-gated events require #p matching your pubkey`. Both clients
    re-issue once after authentication; treating it as final kills a live pump
    for the whole session.
12. **Playwright `getByText` matches a textbox's value.** `fill(body)` followed
    by `getByText(body)` passes even when nothing was sent. Assert on rendered
    text (`page.locator("body").innerText()`) or scope to the message list.
13. **Test DB is polluted.** `buzz_web_test` holds leaked-agent rows. Prefer
    fresh markers per test run; do not delete rows without asking.
14. **Vision.** If your model supports images, capture with Playwright and
    load via the `attach_image` skill, then look before/after every visual
    change. Without vision, use DOM probes + pixel sampling (PIL) as fallback.

## 3. Work state

Landed (this document's original priority list, all done):

- **A. Responsive layout** — collapsible sidebar and slide-over, full-width
  panes below `lg`; `responsive.spec.ts` + `responsive-surfaces.spec.ts`
  (13 surfaces at 390px) cover it (`70ab3ed84`, `8eba10666`).
- **B. Onboarding + account layer** — first-run identity, profile editing that
  merges instead of replacing, wallet bind/unbind, rotatable tab-agent key.
  Remaining nicety: an encrypted nsec backup download (the nsec is still shown
  and stored in plaintext in localStorage).
- **C. Repositories** — `/repos` and `/repos/$repoId` are real routes with a
  detail view, and the detail page has its own inline failure banner.
- **D. Wiki consolidation** — one toolbar row, dirty state, page search,
  rename/delete through the app's dialog, live co-editing with delta merges.
  Open: page identity is slug-scoped (two people creating the same slug are the
  same page), and an unresolvable overlapping edit is still last-writer-wins —
  it now warns the writer instead of losing the text silently.
- **E. Multiplayer feel** — roster-driven "who else is editing" state, live
  delivery with reconnect backoff, notifications poll so mentions arrive while
  the app is open, mention autocomplete that includes humans. Open: no typing
  indicator, and agent memory is browser-local rather than NIP-AE engrams.
- **G. Settings surface** — appearance/theme choice, wallet section, agent
  controls. Open: relay directory management, gateway status.

Cross-cutting work also landed: two-client test harness (`tests/e2e/mock-relay.ts`
with `refuse`, `requireAuth`, `setClosingChannels`, `liveSubscriptionReqs`),
real-relay suite, a11y gate (axe), bundle budget, CSP, rem-only type scale,
visible focus, reduced motion, history pagination, and upload size ceilings.

Open items, roughly by value:

1. **CI has never run on this branch.** The web job's exact steps pass locally
   (`pnpm install --frozen-lockfile`, `just web-check|web-test|web-build|
   web-bundle-budget|web-e2e-smoke`); what is unverified is the Ubuntu runner,
   `playwright install-deps`, and the 15-minute job budget (~5 minutes locally).
2. **Wiki page identity** (slug-scoped) — needs a product decision before
   touching it.
3. **Channel list is capped at 200** with no older-page walk (message history is
   paginated; the channel list is not).
4. **Plaintext nsec in localStorage** and an open `connect-src` in the CSP.
5. **Repository HTML preview runs without its own scripts** (the document CSP is
   inherited by `srcdoc` frames); a separate preview origin would be a relay
   change.
6. **Untestable here**: repos browse needs a git server, the invite flow and
   launchpad chain path need a live relay with real data.

## 4. Verification standard (every item)

1. `pnpm typecheck`, `pnpm check`, `pnpm check:file-sizes`, `pnpm build`,
   `pnpm check:bundle-size`, `pnpm test`, `pnpm test:e2e:smoke` from `web/`
   with hermit active — all green.
2. `pnpm test:e2e:real` when the change touches reads, writes, auth, or static
   serving: it runs the built client against a real relay and asserts the
   deployment contract, a clean page-error log, and a message round trip that
   survives a reload.
3. `cargo build -p buzz-relay` (+ lib tests) if the relay is touched.
4. Falsifiability: for a defect fix, revert the fix, watch the test fail, then
   restore it. A guard whose removal changes nothing protects nothing.
5. Small logical commits with `git commit -s`; tree clean apart from intended
   files.

## 5. Map of the relevant code

- `web/src/app/routes/` — root (gradient is painted on `<body>`; do not use
  fixed negative-z-index layers, they composite above content), index,
  `c.$host`, invite, repos, launchpad.
- `web/src/features/channels/` — `CommunityShell`, `ChannelSidebar`,
  `ChannelTimeline` (header pills, thread maps, history pagination), `Composer`
  (upload limits, mention editor), `use-channel-messages.ts` (history + live
  merge), `subscribe-channel.ts` (NIP-42 + reconnect policy in
  `lib/reconnect.ts`).
- `web/src/features/fleet/` — `browser-agent.ts` (locks, pumps, task loop),
  `use-agent-roster.ts`, `use-agent-tasks.ts`, `use-work-board.ts`, `ui/`.
- `web/src/features/wiki/` — `use-wiki-pages.ts` (cache + relay source of
  truth), `wiki-sync.ts` (Yjs over Trystero, `lib/sync-loop.ts`,
  `lib/text-edit.ts`, `lib/page-index.ts`), `ui/`.
- `web/src/features/notifications|profiles|repos|launchpad|invite|search/
  ` — one feature per surface, each with its own failure state.
- `web/src/shared/lib/` — `nostr-client.ts` (one-shot queries), `identity.ts`,
  `agent-identity.ts`, `publish-event.ts`, `nip98.ts`, `upload-limits.ts`,
  `pubkey.ts`, `relay-url.ts`.
- `web/src/shared/ui/` — primitives including `query-error.tsx` (the shared
  failed-read state) and `confirm-dialog.tsx`.
- `web/tests/e2e/mock-relay.ts` — two-client harness; `web/tests/e2e-real/` —
  real-relay suite + its setup README.
- `crates/buzz-relay/src/api/llm_gateway.rs` — key gateway;
  `handlers/{req,ingest}.rs`, `subscription.rs` — fan-out scoping;
  `crates/buzz-core/src/kind.rs` — kind registry.
- Reference design: `desktop/` (React 19 + TanStack Router; harvest UI +
  relay-client logic, never Tauri shell code).
