# creabuzz — progress & continuation plan

**Last updated:** 2026-08-04
**Branch:** `main` (rebased onto `upstream/main` via `sync/siwe-rebase`)
**Strategy:** adopt upstream clients (Tauri desktop + Flutter mobile); keep only the SIWE/EVM identity layer as fork-specific work.

> **Current task:** port the SIWE onboarding flow into the Tauri desktop app
> (`desktop/`) so the EVM identity layer is usable end-to-end on the client we
> actually ship.

---

## Decision (2026-08-04)

- The custom Expo Router + Tamagui client (`app/`) is **abandoned** — upstream
  maintains a Tauri 2 desktop app and a Flutter mobile app (releases tagged
  `mobile-v0.8.0-rc.*`), so creabuzz adopts those instead of forking a third
  client. The `app/` work survives in git history on the pre-sync `origin/main`.
- `main` was rebuilt on top of current `upstream/main` (293 commits ahead of the
  old merge base) by cherry-picking only the SIWE commits; the Tamagui and
  atproto-appview experiments were dropped.
- Migration `0025_evm_identities.sql` was renumbered to
  **`0027_evm_identities.sql`** (upstream took 0025/0026).

## Completed

### SIWE / EVM identity layer (survived the rebase)

- `crates/buzz-evm-auth/` — SIWE (EIP-4361) + EIP-712 `NostrSigner` attestation
  verification, offline `ecrecover` (19 unit tests green post-rebase).
- `crates/buzz-relay/src/api/evm_auth.rs` — `GET /auth/siwe/nonce` (Redis
  single-use nonce) + `POST /auth/siwe/register` (Nostr proof + SIWE + npub
  binding → auto-membership + `evm_identities`); rate-limited, tenant-scoped,
  feature-gated on `BUZZ_EVM_AUTH`.
- `crates/buzz-db/src/evm_identities.rs` + `migrations/0027_evm_identities.sql`
  — npub↔EVM binding table.
- `crates/buzz-test-client/tests/e2e_siwe.rs` — 4 live-relay tests.
- Relay builds cleanly against rebased upstream; routes registered only when
  `BUZZ_EVM_AUTH` is set (`crates/buzz-relay/src/router.rs`).

## Remaining work

### Phase 4 — SIWE onboarding in the Tauri desktop client

1. Add a "Sign in with Ethereum" onboarding/join path in `desktop/` that drives
   nonce → wallet signature → kind-27235 Nostr proof → `POST /auth/siwe/register`.
2. Wire the resulting membership into the existing community/join flow.

### Phase 2 backend items (still open, upstream-agnostic)

1. **Revocation** — `POST /auth/siwe/revoke`: mark npub revoked in
   `evm_identities`, remove from `relay_members`.
2. **Rotation-continuity events** — old npub signs NIP-26 delegation to new
   npub; clients resolve continuity.
3. **Attestation enforcement at EVENT intake** — relay checks valid attestation
   for kind 40002 publishers.
4. **RPC-backed SignatureVerifier** — EIP-1271/6492 via `BUZZ_ETH_RPC_URL`
   (trait seam ready in `verifier.rs`).
5. **NIP-05 alias endpoint** — optional human names for vanilla Nostr clients.

### Phase 5 — deploy + payments

- Relay deploy (Dockerfile/compose → host of choice), TLS, one domain = one community.
- EVM-wallets record UI, USDC payments (Base L2), optional Lightning zaps.

---

## Environment variables

| Var | Value | Purpose |
|-----|-------|---------|
| `BUZZ_EVM_AUTH` | `true` | Enable SIWE endpoints |
| `BUZZ_EVM_CHAIN_ID` | `8453` | Expected SIWE chain (Base) |
| `BUZZ_ETH_RPC_URL` | (unset) | EIP-1271/6492 RPC (future) |
