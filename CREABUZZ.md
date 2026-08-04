# creabuzz

Creator-focused social app built on a **Nostr data plane** (this fork of [block/buzz](https://github.com/block/buzz)) with an **EVM-native identity layer** — "a better Farcaster" without a new wire protocol.

- [docs/protocol-strategy.md](docs/protocol-strategy.md) — protocol decision (Nostr vs atproto vs EVM hybrid), key-management design, gasless onboarding, compatibility analysis, roadmap.

## What changes vs upstream

- `crates/buzz-evm-auth` — SIWE (EIP-4361) login + EIP-712 `NostrSigner` attestation verification, offline `ecrecover` (19 unit tests). Plus an RPC-backed `RpcSignatureVerifier` (`rpc` feature) that verifies smart-account signatures via EIP-1271 and EIP-6492 (ZeroDev Kernel v2 target).
- `crates/buzz-relay/src/api/evm_auth.rs` + `crates/buzz-db/src/evm_identities.rs` + `migrations/0027_evm_identities.sql` — SIWE auto-provisioning (`GET /auth/siwe/nonce`, `POST /auth/siwe/register`) that replaces manual allowlist/`buzz-admin add-member` onboarding; feature-gated on `BUZZ_EVM_AUTH`.
- **Clients = upstream's.** We adopt upstream's Tauri 2 desktop app (`desktop/`) and Flutter mobile app (`mobile/`) as-is, and port the SIWE onboarding flow into them instead of maintaining a separate client. An earlier Expo Router + Tamagui universal client (`app/`) was built as a prototype and abandoned; it remains in the pre-`sync/siwe-rebase` history on `origin/main`.

Everything is feature-flagged (`BUZZ_EVM_AUTH`) so the relay stays stock-compatible with upstream.

## Working with upstream

```bash
git fetch upstream
git merge upstream/main        # or rebase; expect conflicts in CREABUZZ.md / README fork notes
```

The fork stays close to `upstream/main`: relay-side SIWE work is rebased forward on each sync (migration numbers may need renumbering against new upstream migrations).

## Phase plan

0. Repo consolidation → 1. relay baseline → 2. `buzz-evm-auth` + SIWE auto-provisioning (done) → 3. sync to upstream `main`, adopt upstream clients (done) → 4. SIWE onboarding in the Tauri desktop client → 5. deploy relay → 6. payments/bridges.
