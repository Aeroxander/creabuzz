# Buzz Web ("Creaton")

The browser client the relay serves at `/` (`BUZZ_WEB_DIR=./web/dist`). It is a
full community client, not only a repo browser: channels and a live timeline,
threads and reactions, the community directory, wiki with live co-editing, the
agent fleet (including an in-tab agent), the work board, notifications, search,
profiles, repositories, and the DAO launchpad.

The desktop app remains the reference client; feature-parity work is tracked in
`docs/web-ui-roadmap.md`.

## Surfaces

| Surface | Routes |
|---|---|
| Directory + invite landing | `/`, `/invite/$code` |
| Community shell | `/c/$host` (`?channel=<uuid>` deep link) |
| Repositories | `/repos`, `/repos/$repoId`, `/repos/$repoId/blob/$` |
| Launchpad | `/launchpad`, `/launchpad/$launchId` |
| Social (Twitter-style) | `/social` (Creaton feed + Following), `/social/explore`, `/social/search`, `/social/tag/$tag`, `/social/post/$id`, `/social/notifications`, `/social/messages[/$peer]`, `/social/bookmarks`, profiles at `/u/$pubkey` |

Wiki, fleet, work board and org views are panels of the community shell (the
sidebar toggles), not separate routes.

### Social section

`src/features/social` is a Twitter-style client built on standard Nostr events
only (kinds 1, 6, 16, 7, 3, 10000, 10003, 10050, 1059 …), so posts, follows and
reposts are readable by other Nostr clients, and DMs are NIP-17 (0xchat
compatible) and separate from Buzz channel DMs. The "Creaton feed" is every post
on this relay, not all of Nostr. Bookmarks and DMs need NIP-44 from the signer
(passkey, stored nsec, or a NIP-07 extension that exposes `nip44`). Post search
is client-side because the relay's full-text index does not cover kind 1.
The Creaton tab is ordered by recency lifted by engagement, with likes weighted
by social trust (a seeded PageRank over the follow graph, `social/lib/trust.ts`).
The blend grows smoothly with community size: under ~25 accounts every like
counts the same and the feed is nearly chronological; it leans fully on trust
(capped at 80%) around 1,000. This is separate from the launchpad's reputation
and TrustGraph. Following stays chronological.

Real-relay coverage: `node tests/e2e-real/seed.mjs` then
`node --experimental-strip-types tests/e2e-real/seed-social.mjs`, then
`pnpm test:e2e:real`.

### Preview gating

`preview-features.json` gates preview features in the **desktop** app only; the
web client does not read it, so a feature listed there as desktop-only (for
example `launchpad`) still ships here. That file also validates its `platforms`
against `["desktop", "mobile"]` — add a platform there only together with the
desktop schema, or the manifest fails validation and every preview feature
silently disappears from the desktop app.

## Serving

```bash
pnpm build                 # writes web/dist
BUZZ_WEB_DIR=./web/dist    # relay serves the bundle at /
```

The relay serves the bundle at `/` when `text/html` is requested. `BUZZ_WEB_SPA=full`
makes every unknown path fall back to the SPA (required for the client-side
routes above); the default fallback covers only the invite and repo paths.

## Connecting to a relay

The app dials the relay over WebSocket. Resolution order:

1. `localStorage["buzz.relayUrl"]` — set from the "Couldn't reach the relay"
   connect form when the app is served from a non-relay origin.
2. `VITE_RELAY_URL` — baked in at build time (`VITE_RELAY_URL=wss://relay.example.com pnpm build`).
3. Same origin — works whenever the relay itself serves the bundle.

Served from any other host (vite preview, a CDN, GitHub Pages), the app
cannot derive the relay from `window.location` and will show the
"Couldn't reach the relay" screen; enter the community relay URL there to
connect.

## Identity

Sign-in options, in precedence order: an active passkey signer (WebAuthn PRF
derives the key, nothing is stored), NIP-07 browser extension, or the durable
key in `localStorage["buzz.identity.nsec"]`. Wallet sign-in (SIWE) binds an
EVM address to the npub for launchpad participation.

## Development

```bash
pnpm dev                   # vite dev server
pnpm typecheck
pnpm check                 # biome + pubkey truncation + px-text guards
pnpm check:file-sizes      # per-surface file-size ratchet
pnpm test                  # node:test unit tests (no browser or relay)
pnpm check:bundle-size     # first-load budget; needs a build first
pnpm test:e2e:smoke        # build + playwright suite (mocked relay)
pnpm test:e2e:real         # built client against a real relay
```

`pnpm test:e2e:real` needs a relay serving the built bundle plus a seeded
community; `tests/e2e-real/README.md` has the setup. Keep it green when
touching the read, write, auth, or static-serving paths — it is the only suite
that sees the real deployment (it caught the theme bootstrap being served as
HTML, and a NIP-42 handshake race that killed live subscriptions).

`scripts/web-auction-e2e.sh` (from the repo root) deploys the auction from the
browser against a **real local chain**: it builds the contracts, boots its own
Anvil with the CCA factory's code at its canonical address, deploys a sale
currency and token, and runs `tests/e2e/launchpad-auction.spec.ts` with a wallet
that forwards to that chain. It needs foundry (`FOUNDRY_BIN` if it is not on
`PATH`); set `PW_CHROMIUM_PATH` if the pinned Playwright wants a newer browser
build than the machine has. The spec skips itself when its `E2E_*` variables are
unset, so the default smoke run is unaffected.

The e2e suite runs against `vite preview` on 127.0.0.1:4173 and serves the last
**built** bundle: run `pnpm build` first, and kill whatever holds port 4173, or
the suite tests a stale build.

## Preview limits

The repository HTML preview runs without its own scripts: `srcdoc` frames
inherit the document CSP, so any `<script>` in a previewed file is blocked. A
separate preview origin would lift that, but it is a relay change.

## Layout

`src/app` (routes, boundary views), `src/features/<domain>` (UI + hooks per
surface), `src/shared` (transport, identity, UI primitives, kinds).
