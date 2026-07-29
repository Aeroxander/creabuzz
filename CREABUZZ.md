# creabuzz

Creator-focused social app built on a **Nostr data plane** (this fork of [block/buzz](https://github.com/block/buzz)) with an **EVM-native identity layer** — "a better Farcaster" without a new wire protocol.

- [docs/protocol-strategy.md](docs/protocol-strategy.md) — protocol decision (Nostr vs atproto vs EVM hybrid), key-management design, gasless onboarding, compatibility analysis, roadmap.

## What changes vs upstream

- `crates/buzz-evm-auth` — SIWE (EIP-4361) login + EIP-712 `NostrSigner` attestation verification, offline `ecrecover` (19 unit tests). EIP-1271/6492 RPC verifier plugs into its `SignatureVerifier` trait next.
- `crates/buzz-relay/src/api/evm_auth.rs` + `crates/buzz-db/src/evm_identities.rs` + `migrations/0025_evm_identities.sql` — SIWE auto-provisioning (`GET /auth/siwe/nonce`, `POST /auth/siwe/register`) that replaces manual allowlist/`buzz-admin add-member` onboarding; feature-gated on `BUZZ_EVM_AUTH`.
- `app/` *(planned)* — Expo Router + Tamagui universal client (web/iOS/Android). Upstream ships Tauri desktop, Flutter mobile, and a repo-browser web app, none of which creabuzz builds on.
- `attic/web-atproto/` — earlier atproto-port experiment (One/Tamagui, `@atproto/api`); kept for UI reference only, not built.

Everything is feature-flagged (`BUZZ_EVM_AUTH`) so the relay stays stock-compatible with upstream.

## Working with upstream

```bash
git fetch upstream
git merge upstream/main        # or rebase; expect conflicts in README.md (fork note on top)
```

## Phase plan

0. Repo consolidation (this commit) → 1. relay baseline (`just relay`, stock NIP-29 client connects, `just ci` green) → 2. `buzz-evm-auth` → 3. `app/` client (Privy + SIWE onboarding) → 4. deploy relay + web app → 5. payments/bridges.
