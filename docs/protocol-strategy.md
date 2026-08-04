# creabuzz protocol strategy

**Status:** draft v1 · 2026-07-28
**Question:** Nostr, atproto, or an EVM-native hybrid ("a better Farcaster") as the foundation for creabuzz?

## 1. Context & assets

creabuzz explores turning Buzz (Block's Nostr-native team-comms platform) into a creator-focused social app.

- **`~/Applications/buzz`** — complete Nostr stack in Rust: `buzz-relay` (NIP-01 wire, NIP-42/98 auth), `buzz-sdk`, `buzz-cli`, `buzz-acp` (AI-agent harness), workflows, search, audit, Blossom media, NIP-AB device pairing.
- **`buzz/web-atproto`** — milestone-1 atproto client (One/Tamagui, `@atproto/api`, OAuth, custom `com.buzz.*` lexicons + planned AppView). Kept as reference; its OAuth client code is reusable for a future "login with Bluesky".
- **`creabuzz`** — greenfield (this repo).

## 2. Protocol comparison

| Dimension | Nostr | atproto | Farcaster | creabuzz hybrid (proposed) |
|---|---|---|---|---|
| Identity root | secp256k1 keypair (npub) | DID (PLC / did:web) + handle | Onchain fid ↔ ETH address | EVM account (EOA or counterfactual ERC-4337) |
| Key rotation / recovery | None standardized (known gap) | Yes (DID rotation) | Yes (custody addr + signers) | Yes (delegated signer npubs) |
| Human names | NIP-05 (DNS, weak) | Domains as handles (strong) | ENS | Optional (NIP-05 alias and/or ENS); EVM address is the native handle |
| Data model | JSON events, 6 fields | MST repos, CAR, DAG-CBOR, lexicons | Snapchain / hubs | Nostr events unchanged |
| Global view | Relay-dependent (weak) | Firehose + AppViews (strong) | Snapchain (strong) | Aggregator relay (pragmatic) |
| Payments | Lightning zaps (native) | None | EVM | EVM (USDC on L2) and/or zaps |
| Dev UX | Learnable in hours | Weeks ("stacks upon stacks of specs" — HN) | Moderate | Nostr + a slice of Ethereum |
| Ops burden | One relay | PDS + relay + AppView + firehose | Snapchain nodes | buzz-relay + ETH RPC (+ CCIP gateway only if ENS opted in) |
| Network size | 16–18M keys claimed; DAU est. low 10Ks | 30M+ accounts (2025) | 80K DAU at $150M raise (2024) | Bootstraps on Nostr + bridges |
| EVM fit | Same curve, no tooling | None | Native | Native |
| App-store risk | Zaps vs Apple (Damus, 2023) | Low | Medium (crypto) | Medium (mitigate: payments optional) |

## 3. The layered architecture

Data plane ≠ identity plane ≠ money plane ≠ distribution plane. Pick the best tool per layer instead of one protocol for everything:

- **Data:** Nostr NIP-01 via `buzz-relay`, unchanged. Events remain 100% standard; every relay/client interoperates.
- **Identity:** EVM. Root = EOA or counterfactual ERC-4337/7579 smart account; SIWE (EIP-4361) for login; EIP-712 / EIP-1271 (/ EIP-6492) attestations authorize per-device Nostr signer keys. ENS optional, not required.
- **Money:** EVM rails (USDC on an L2) and/or Lightning zaps.
- **Distribution:** bridges (Bridgy Fed: atproto ↔ ActivityPub ↔ Nostr; mostr.pub) instead of per-protocol rewrites.

Happy accident: Nostr (BIP-340 Schnorr) and Ethereum (ECDSA) share the secp256k1 curve, so one ecosystem of key hardware/libraries covers both. Wallets still won't Schnorr-sign — hence delegation rather than key reuse (also better key hygiene).

## 4. Key-management designs

### Design 1 — npub as root (pure Nostr)

Identity = the Nostr secret key. Loss = death; there is **no standardized rotation NIP** (NIP-05 naming, NIP-26 delegation, NIP-46 remote signers exist; rotation does not). Stable-npub *with* rotation requires threshold-Schnorr (FROST) with guardians holding nsec shares — i.e. an MPC network. Bleeding edge; rejected as the primary design.

### Design 2 — EVM root + delegated npubs (recommended)

- **Root:** EOA or ERC-4337/7579 smart account (guardians, session keys, social recovery). A Privy embedded wallet (TEE-secured, key export supported) can be one owner; passkeys/hardware wallets are others.
- **Signers:** per-device Nostr keys (buzz already ships NIP-AB device pairing), authorized by an EIP-712 attestation:

```json
{
  "types": {
    "NostrSigner": [
      { "name": "account", "type": "address" },
      { "name": "npub",    "type": "bytes32" },
      { "name": "expires", "type": "uint256" },
      { "name": "nonce",   "type": "uint256" }
    ]
  }
}
```

- **Published** as a NIP-33 parameterized-replaceable event (app kind, e.g. 30xxx, `d="evm-signer"`), so attestations gossip like any Nostr data. A separate "EVM wallets" record (same pattern as the atproto EVM-link record) lists payment addresses — multiple wallets allowed, independent of the SIWE login key. Optional NIP-05 alias (`alice@creabuzz` → current npub) for human names; ENS not required.
- **Verification:** `ecrecover` for EOAs (free, local); EIP-1271 `isValidSignature` for deployed smart accounts; EIP-6492 unwrap for counterfactual (not-yet-deployed) accounts. `buzz-relay` verifies at EVENT intake and caches; EVM-aware clients do the same.
- **Rotation:** publish a new attestation (+ revocation of the old). Followers reference the EVM account, so nothing breaks in EVM-aware clients. The old npub also signs a NIP-26-style delegation to the new npub — a continuity claim any client can display.
- **Optional later:** a minimal onchain KeyRegistry (Farcaster's exact pattern) for canonical revocation/disputes.

### Design 3 — MPC / threshold custody (optional add-on)

MPC (Privy/Turnkey for ECDSA; FROST for Schnorr) solves *custody*, not rotation. Useful as a hosted-root or hosted-bunker option (NIP-46). Never a requirement.

### Staged rollout (mirrors the proven atproto+EVM pattern)

Prior art: an atproto project added SIWE to the PDS for registration/login, then an EVM-link record on the profile for payments (multiple wallets, not necessarily the SIWE key). The Nostr equivalent maps 1:1 with less surgery:

| atproto pattern | Nostr equivalent |
|---|---|
| SIWE auth patched into the PDS | SIWE verified by `buzz-relay` alongside NIP-42/98 — auth is already pluggable, no server fork |
| EVM-link record in the profile repo | Replaceable "EVM wallets" event kind (NIP-33), gossiped by every relay, indexed trivially |
| DID remains identity root | Stage A: npub stays root, EVM record = metadata only. Stage B: promote the EVM account to root (rotation/recovery) when needed |

Stage A is metadata-only and 100% network-compatible; Stage B adds rotation but moves identity semantics into the overlay (§5–6). Starting at A keeps both doors open.

## 5. Downsides of Design 2 (honest list)

1. **Rotation looks like a new account to vanilla clients.** Follows, DMs (NIP-04/17), and zaps are npub-keyed. Delegation events + NIP-05 names mitigate, but automatic continuity exists only in EVM-aware clients.
2. **Two systems to learn.** "Nostr in an afternoon" becomes "Nostr + SIWE + EIP-712/1271/6492 + ERC-4337". Still far below atproto's surface area (no MST/CAR/DID/PLC/lexicon stack).
3. **Relay gains an Ethereum dependency.** RPC for EIP-1271 checks, chain selection (multichain accounts), 6492 handling, verification caching.
4. **Overlay dependency.** Full identity semantics live in the creabuzz overlay; without it, users degrade to bare npubs — functional, but no rotation graph.
5. **No native human names.** Without ENS, handles are EVM addresses (or optional NIP-05 aliases that you operate). Fine for crypto-native users; a UX gap for mainstream.
6. **Onchain extras cost gas.** Guardian changes, registry writes, account deployment need paymaster sponsorship; a pure-EOA root has no recovery path.
7. **Spec-drift & hot-key security.** If Nostr standardizes rotation differently, you migrate. Device keys need short attestation expiry, revocation discipline, and EIP-712 domain separation against replay.

## 6. Compatibility with the rest of Nostr

| Capability | Vanilla relay | Vanilla client | EVM-aware client |
|---|---|---|---|
| Accept/read events (NIP-01) | ✅ | ✅ | ✅ |
| Follow, reply, zap an npub | ✅ | ✅ | ✅ |
| Human names (via NIP-05) | — | ✅ | ✅ |
| Attestation events gossip | ✅ (opaque) | ✅ (opaque) | ✅ verified |
| Rotation continuity | — | ⚠️ manual (delegation posts) | ✅ automatic |
| Revocation enforcement | — | ⚠️ | ✅ |
| DMs (NIP-04/17) | ✅ | ✅ npub-keyed (rotate = new convo) | ✅ (re-key with notice) |

**Verdict: not a fork — an overlay on standard Nostr.** Same posture as Farcaster signers vs raw keys, or atproto DIDs vs bare keys: the base layer stays universally interoperable; the identity layer is an opt-in enhancement that degrades gracefully.

## 7. Gasless registration (hard requirement: zero gas to join)

1. **Wallet:** Privy embedded wallet — keygen in a TEE, no transaction, free. (Passkey or external wallet also supported.)
2. **Identity — two gasless paths:**
   - *EOA root:* everything offchain; `ecrecover` verification costs nothing. Downside: no guardian recovery for the root.
   - *Counterfactual smart account:* address derived via CREATE2 factory; nothing deployed. Signatures are EIP-6492-wrapped so verifiers accept them pre-deployment. The first onchain action (guardian setup, registry write, payment) deploys the account — sponsored by an ERC-4337 paymaster.
3. **Name (optional):** none required — the EVM address is the handle. Human aliases can be served via a NIP-05 endpoint you operate (zero gas); ENS stays an optional extra for users who bring their own name.
4. **Signer:** device generates a Nostr keypair; wallet signs the EIP-712 attestation; published to your relay. Free.

→ **Registration = 0 transactions, 0 gas.** The trilemma (gasless + self-custody + recovery) is sequenced rather than solved: Privy's built-in recovery covers day one; adding guardians triggers the first (sponsored) deployment later.

## 8. Changes to buzz-relay

- New crate `buzz-evm-auth`: SIWE (EIP-4361) login + attestation verification (ecrecover / EIP-1271 / EIP-6492 via `alloy`), TTL cache, chain-RPC config; enforced at EVENT intake only for kinds that require attested identities.
- Kind-registry additions: signer attestation (NIP-33 replaceable), revocation, EVM-wallets link record.
- Optional NIP-05 alias endpoint. NIP-42/98 untouched.
- No changes to wire format, storage, or fan-out. Vanilla relays/clients keep working untouched.

## 9. Roadmap

- **Phase 0 — validation (this doc + spikes):** ecrecover/1271/6492 in Rust (`alloy`, `k256`); SIWE flow against `buzz-relay`; confirm Privy + counterfactual-4337 flow.
- **Phase 1 — relay:** `buzz-evm-auth` + attestation kinds; `buzz-sdk`/`buzz-cli` support.
- **Phase 2 — client:** Privy onboarding (SIWE), device keygen + pairing, EVM-wallets link-record UI, optional NIP-05 aliases.
- **Phase 3 — money:** USDC on an L2 and/or Lightning zaps.
- **Phase 4 — distribution:** Bridgy Fed / mostr.pub bridging; optional onchain KeyRegistry; publish the attestation kind as a NIP PR.

## 10. Risks & open questions

- App-store crypto rules (Damus zaps precedent, 2023) — keep payments optional and web-first.
- Global view needs an aggregator relay → real infra cost (Nostr's known weakness vs the atproto firehose).
- Nostr may standardize rotation differently → migration cost later.
- Privy vendor lock-in → mitigate via key export and wallet-agnostic EIP-1271 verification.
- Which L2 hosts the optional registry/payments; multichain smart-account resolution.
- Whether stock Nostr clients adopt the delegation-continuity convention (⚠️ rows in §6).

## Sources

- HN [#42751311](https://news.ycombinator.com/item?id=42751311) — atproto complexity vs Nostr simplicity; Nostr key-rollover criticism (Jan 2025)
- TechCrunch — Dorsey's $10M to open-source social (Jul 2025); Farcaster's $150M raise at 80K DAU (May 2024)
- Wikipedia: Nostr, Bluesky (fetched 2026-07-28); Bluesky 30M+ accounts (2025)
- docs.farcaster.xyz — Sign In with Farcaster, mini apps, Snapchain
- docs.privy.io — TEE embedded wallets (EVM/Solana), no Schnorr/BIP-340
- nostr-protocol/nips — NIP-05 / NIP-26 / NIP-46 exist; no key-rotation NIP
- EIP-712, EIP-1271, EIP-6492, EIP-4361 (SIWE), ERC-4337, ERC-7579, ENSIP-10 + EIP-3668 (CCIP-read)


