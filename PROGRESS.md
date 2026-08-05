# creabuzz — progress & continuation plan

**Last updated:** 2026-08-05
**Branch:** `main` (rebased onto `upstream/main` via `sync/siwe-rebase`)
**Strategy:** adopt upstream clients (Tauri desktop + Flutter mobile); keep only the SIWE/EVM identity layer as fork-specific work.

> **Current task:** ✅ SIWE is end-to-end: relay lifecycle (register/revoke/
> attestation), ZeroDev smart-account signing in the desktop client, and the
> onboarding UI. Remaining is deploy + live-chain E2E.

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

### SIWE / EVM identity layer

- `crates/buzz-evm-auth/` — SIWE (EIP-4361) + EIP-712 `NostrSigner` attestation
  verification, offline `ecrecover` (19 unit tests green post-rebase).
- `crates/buzz-relay/src/api/evm_auth.rs` — `GET /auth/siwe/nonce` (Redis
  single-use nonce) + `POST /auth/siwe/register` (Nostr proof + SIWE + npub
  binding → auto-membership + `evm_identities`); rate-limited, tenant-scoped,
  feature-gated on `BUZZ_EVM_AUTH`.
- `crates/buzz-db/src/evm_identities.rs` + `migrations/0027_evm_identities.sql`
  — npub↔EVM binding table.
- `crates/buzz-test-client/tests/e2e_siwe.rs` — 4 live-relay tests.

### RPC-backed SignatureVerifier (ZeroDev target)

- `buzz-evm-auth::rpc::RpcSignatureVerifier` (`rpc` feature): EIP-1271 for
  deployed accounts, EIP-6492 counterfactual via the `UniversalSigValidator`
  singleton (`BUZZ_EVM_ERC6492_VALIDATOR`), EOA `ecrecover` fallback. Wired into
  `/auth/siwe/register` when `BUZZ_ETH_RPC_URL` is set.
- Unit-tested (32 rpc / 30 default). **Follow-up:** live-chain E2E + deploying
  the validator singleton for the counterfactual path.

### Soft revocation (Phase 2 item #1) ✅

- `migrations/0028_evm_revocation.sql` — `revoked_at` / `revoked_by` /
  `revoked_reason` on `evm_identities`.
- `buzz-db`: `revoke_evm_identity`, `is_evm_identity_revoked`,
  `unrevoke_evm_identity`, and Db wrappers for `get_evm_identity` /
  `list_identities_for_address`.
- `POST /auth/siwe/revoke` — Nostr-proof-authed, marks revoked + removes
  `relay_members`. Re-register of a revoked npub → 403 `evm_identity_revoked`.
- e2e: revoke happy path + unregistered + address-mismatch.

### Attestation enforcement (Phase 2 item #3) ✅

- `buzz-evm-auth`: `AttestationEnvelope` (attestation + domain + signature) with
  `verify_for_npub` (signature + expiry + npub binding); serde round-trip.
- `/auth/siwe/register` accepts + verifies an optional `attestation` and stores
  it on the binding.
- Intake gate (`handlers/ingest.rs`): when `BUZZ_EVM_ENFORCE_ATTESTATION` is on,
  kind-40002 publishers with an `evm_identities` binding must carry a valid,
  unexpired, non-revoked attestation.

### Desktop SIWE onboarding (Phase 4) ✅

- **Rust (`desktop/src-tauri`)**: `commands/siwe.rs` — `siwe_get_account`
  (generate/persist EVM owner key in the OS keyring under `siwe:evm:owner`,
  derive the ZeroDev Kernel v3.3 EIP-7702 account), `sign_siwe_message`
  (EIP-191 `personal_sign` via k256), `siwe_has_account`. `siwe_config.rs`
  reads `BUZZ_ZERODEV_PROJECT_ID` / `BUZZ_ZERODEV_RPC_URL` /
  `BUZZ_EVM_CHAIN_ID` (defaults: Sepolia 11155111, the creabuzz ZeroDev
  project). 4 Rust unit tests, clippy + fmt clean.
- **Frontend**: `shared/api/siwe.ts` (nonce GET, SIWE message builder,
  register POST, tauri wrappers); `useSiweRegister.ts` driving the new
  `siwe-registering` stage; `communityOnboarding.tsx` gains a `"siwe"` source;
  `WelcomeSetup.tsx` gains a "Sign in with Ethereum" card + URL entry; the flow
  transitions to `connecting` so the existing add-community handler completes.
  24 frontend tests pass (incl. new SIWE source/message tests); tsc + biome clean.

## Remaining work

### Live verification

1. ✅ **e2e_siwe + revoke + attestation** — 13/13 live-relay tests pass against
   Dockerized Postgres + Redis (register, idempotent re-register, revoke +
   revoked-re-register, attestation, rotation accept/forged-reject, NIP-05).
   Run with `BUZZ_EVM_AUTH=true` (relay from `.env`) +
   `cargo test -p buzz-test-client --test e2e_siwe -- --ignored`.
2. **ZeroDev live round trip** — desktop signs a Sepolia SIWE → relay verifies
   via `BUZZ_ETH_RPC_URL` → membership provisioned. Deploy the EIP-6492
   `UniversalSigValidator` singleton on Sepolia for the counterfactual path.
3. **Desktop app build** — needs `cmake`, sidecar stubs (`just
   _ensure-sidecar-stubs`), and the prebuilt `buzz-acp` sidecar; verify a full
   Tauri build + the onboarding UI end to end.

### Backend items (recently completed)

1. ✅ **Rotation-continuity events** — `KIND_EVM_ROTATION` (30200, NIP-33). The
   old npub publishes a NIP-26 `delegation` tag signed over
   `sha256("nostr:delegation:<new>:<conditions>")` (k256 Schnorr). Verified at
   ingest (forged tokens rejected), stored, and resolvable by
   `{kinds:[30200], authors:[old]}`. buzz-core unit tests + live e2e.
2. ✅ **NIP-05 alias wiring for SIWE users** — `POST /auth/siwe/register`
   accepts an optional `nip05_handle` (validated against the tenant host via
   `canonicalize_nip05`), upserted into `users` so `/.well-known/nostr.json`
   resolves the alias to the npub even before a kind:0 profile exists. Live e2e
   (alias resolves; foreign domain rejected).

### Phase 5 — deploy + payments

- Relay deploy (Dockerfile/compose → host of choice), TLS, one domain = one community.
- EVM-wallets record UI, USDC payments (Base L2), optional Lightning zaps.

---

## Environment variables

| Var | Value | Purpose |
|-----|-------|---------|
| `BUZZ_EVM_AUTH` | `true` | Enable SIWE endpoints |
| `BUZZ_EVM_CHAIN_ID` | `11155111` | Expected SIWE chain (Sepolia for ZeroDev) |
| `BUZZ_ETH_RPC_URL` | (set) | EIP-1271/6492 verification RPC |
| `BUZZ_EVM_ERC6492_VALIDATOR` | (deployed address) | Counterfactual account verification |
| `BUZZ_EVM_ENFORCE_ATTESTATION` | `false` | Require attestation at kind-40002 intake |
| `BUZZ_ZERODEV_PROJECT_ID` | creabuzz project | Desktop ZeroDev project |
| `BUZZ_ZERODEV_RPC_URL` | ZeroDev RPC | Desktop ZeroDev JSON-RPC |
