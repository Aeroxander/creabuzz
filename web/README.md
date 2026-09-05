# Buzz Web

The web app served by the relay at `/`. It is a lightweight browser client:
repository browsing (list, detail, tree, blob viewer, commits, README) plus
the invite/join landing pages. It is intentionally smaller than the desktop
client; feature parity work is tracked in the repo issue tracker.

## Serving

Point the relay at a production build:

```bash
pnpm build                 # writes web/dist
BUZZ_WEB_DIR=./web/dist    # relay serves the bundle at /
```

The relay serves the bundle at `/` when `text/html` is requested; only the
invite landing and repo-browse paths fall back to the SPA by default
(`BUZZ_SERVE_GIT_WEB_GUI=true` extends the fallback to repo paths).

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

## Development

```bash
pnpm dev                   # vite dev server
pnpm typecheck
pnpm check                 # biome + file-size + pubkey guards
pnpm test:e2e:smoke        # build + playwright smoke suite
```
