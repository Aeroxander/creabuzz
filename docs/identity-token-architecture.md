# Creaton identity & token architecture

Status: agreed design — the identity layer that communication, tasks, and the
DAO launchpad all sit on. Captures the decisions from the web-app work
(`web-passkey` branch) and the `dao-launchpad` branch's EVM work.

## 1. The identity model (three layers, independent roots)

| Layer | Root secret | Mechanism | Recovery |
|---|---|---|---|
| Nostr identity | WebAuthn **PRF (HMAC-Secret)** output → HKDF-SHA256 → secp256k1 key | PRF extension; key exists only in page memory; account is per-credential+salt | One-time **nsec backup** (portable, cross-platform); ecosystem sync re-derives within it |
| EVM / smart-wallet identity | The **same passkey's secp256r1 key** as an ERC-7579 **WebAuthn validator** on a ZeroDev Kernel (EIP-7702) | WebAuthn assertion; verified in-contract (EIP-7212) | **AA social recovery** (guardian / second passkey) |
| Membership / provenance | `npub ↔ EVM` **binding** in `evm_identities` (dao-launchpad SIWE module) | SIWE attestation (below) | Re-issue membership through the wallet |

**One passkey registration ceremony creates one credential that serves both
layers** — the PRF extension derives the Nostr key; r1 signatures control the
smart wallet. No EOA private key ever touches the page.

## 2. Why the PRF key is NOT the EOA

- Same curve/scalar shape (secp256k1) makes it *technically* possible; it is
  deliberately **not** done:
  - **Single failure domain**: passkey loss would destroy both the (unrecoverable)
    Nostr identity and the (recoverable-by-design) smart wallet.
  - **Non-standard wallet path** and ecosystem fragility (PRF varies across
    unsynced platforms).
- The two identities stay cryptographically separate and are **linked only by
  attestation** — the SIWE binding.

## 3. Wallet → npub binding (SIWE, from dao-launchpad)

1. `GET /auth/siwe/nonce` (single-use, 10 min, Redis).
2. `POST /auth/siwe/register` with three proofs:
   - **Nostr proof**: kind 27235 signed by the npub's key, content = EVM
     address, `u=/auth/siwe/register`.
   - **SIWE** `personal_sign` by the EVM wallet, `Resources: nostr:<npub>`.
   - Optional EIP-712 attestation (enforced with `BUZZ_EVM_ENFORCE_ATTESTATION`).
3. Relay verifies + `ecrecover` (k256), stores the binding, adds the npub as a
   member (`added_by = 'evm_siwe'`).

## 4. Launchpad web flow (sketch)

```
Sign in                      Create / join           Launch
─────────────────────────────────────────────────────────────────────
passkey touch                project (community)     token deploy via AA
  ├─ PRF  → nostr identity   ├─ SIWE binding          ├─ create project
  └─ r1   → Kernel owner     │  (wallet ⇄ npub)       │  → token metadata
membership via evm_identities└─ member roster          └─ agents + tasks
                                                      run underneath (fleet)
```

- Projects ARE communities: a community row + channel for `#launch`, tasks on
  the work board (agents contribute), and a **Launch panel**: token metadata
  (name/symbol/supply), deploy via the passkey-controlled Kernel, then
  community distribution tied to `evm_identities` membership.
- The relay stays the only server: contract calls flow from the web app
  through the AA bundler (ZeroDev-hosted or self-hosted on the relay host);
  the chain-events relay indexer (dao-launchpad) mirrors on-chain state back
  into relay events (47006 receipts).

## 5. Sequencing

**Refinement gate (before switching to launchpad):**
1. @mentions + notifications
2. Human assignee roster (members → task assignees)
3. Git issue (1621) writes from the board
4. Passkey/Safari PRF confirmation (keyless default vs unlock fallback)
5. **SIWE onboarding** (the bridge; also launchpad prerequisite)

**Switch — launchpad integration:**
6. Port `dao-launchpad` relay work (buzz-evm-auth, evm_auth routes, chain
   indexer, Kernel/contracts, siwe-demo) onto the current main line
7. Web: passkey sign-in → membership → project → Launch (token) panel
8. Fleet underneath: agents + work board drive project ops

## References

- dao-launchpad branch: `crates/buzz-evm-auth`, `crates/buzz-relay/src/api/evm_auth.rs`,
  `desktop/src-tauri/src/commands/siwe.rs`, Launchpad UI, `siwe-demo` scripts.
- Web: `web/src/features/identity` (passkey PRF + unlock modes), `web/src/features/fleet`
  (work board, agents).
