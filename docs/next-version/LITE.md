# Creaton Lite

Status: the `lite` branch, cut from `v6.5` on 27 November 2026. The full line before the cut is the tag `v6.5-full`.
Money is play dollars on a test network. Nothing here is legal or tax advice.

## What this branch is

The same product as `v6.5` with the code that does not ship removed from the tree, so the repository matches what a
backer, a founder and the server actually use. Nothing about the product changed: the app, the relay, the migrations
and `contracts/pot` are as they were on `v6.5`.

## What was removed

| Removed | Why |
|---|---|
| `web/` and `admin-web/` | The old web app and its admin bundle. The image served them by default; it now serves `app/`. |
| `desktop/` | The desktop app and its release pipeline. |
| `mobile/` | The Flutter app and its release scripts. |
| `contracts/src`, `contracts/next`, `contracts/test`, `contracts/script`, `contracts/deployments` | The two earlier contract lines. `contracts/pot` is the one the app reads. |
| `contracts/lib` submodules other than forge-std and OpenZeppelin | Only the earlier lines used them. `apptoken-dev` went with them. |
| Workflows, scripts and Justfile recipes for the above | They built, tested or released only the removed code. |

## What stays

- The relay and its Rust crates, and every migration (0001 onward: the server needs them in order).
- `app/` (the phone-first web app, `@creaton/app`) and `packages/creaton-core`.
- `contracts/pot`, with `contracts/lib/forge-std` and `contracts/lib/openzeppelin-contracts`.
- `deploy/compose`, the Docker image (`runtime`, also `runtime-creaton`) and the pot journeys.

## What was not cut, on purpose

- No app features were removed. The routes, tabs and sheets are the same as on `v6.5`. Cutting those waits for the pot
  journeys and a real-phone join and leave test (see below).
- Rust crates: 19 were removed in a second commit (the agent harness `buzz-acp`, `buzz-agent`, `sprig`, `buzz-dev-mcp`
  and `git-*-nostr`; the fleet crates; the iOS push gateway; the device-pairing crates; and orphans). 23 remain.
  Inside the kept crates, the relay still holds code for the removed pieces: `audio/` (huddle audio) and `buzz-persona`'s `buzz-agent` runtime branch.
- Old launchpad code inside `packages/creaton-core/src/launchpad` stays until its tests are rewritten to stand alone.

## Known gaps after the cut

- `packages/creaton-core` still exports about 400 things (mostly in `launchpad/`) that only the removed clients used.
  The unused-exports scan is switched off for that package in `knip.jsonc` until they are cut; turn
  `includeEntryExports` back on to list them.
- `scripts/ci-selection.test.mjs` needs the pinned paths-filter action bundle (`PATHS_FILTER_ACTION`) and was not run
  here. The other script tests pass.
- Shell journeys that need services (`pot-full-loop`, `pot-chain-loop`, `app-real-loop-e2e`) had only their file paths
  repointed. They have not been run on this branch.
- Three Rust tests that read the desktop's TypeScript now use pinned values taken from `v6.5-full` instead (the v1 audit
  digest, the audit envelope field list), and one voice test reads its reference sound from `BUZZ_VOICE_REFERENCE_WAV`.
- The link-preview card image moved to `app/public/assets/share-card.png`.

## Before cutting further

1. Run the 90 pot journeys that were skipped on this line.
2. Test join and leave with a passkey on a real phone. Nobody has.

Features come out only after those two pass, so a broken base is not mistaken for dead weight.

## Getting the removed code back

```bash
git checkout v6.5-full -- web desktop mobile admin-web
```

Or branch from the tag: `git switch -c restore v6.5-full`.
