# ANS interop — what converges, what must not cross, and the one thing to steal

`draft` `research` `aos` `interop`

Companion to [OAv2.md](../../OAv2.md) §3 (the layer map) and §4.10 (version
binding). This document answers one question: **does Buzz need the Agent Name
Service?**

**Short answer: no.** Four of ANS's seven layers are already implemented here
under different names on better substrates; its trust model is a principled
incompatibility with Nostr; and adopting it would make Buzz's agent identity
contingent on a registrar's commercial roadmap. But **ANS-2 asks a question we
cannot currently answer**, and that question is worth taking.

---

## 1. What ANS actually is

| | |
|---|---|
| Live spec | [`agentnameservice/ans-registry`](https://github.com/agentnameservice/ans-registry) — 7 layered specs, Apache 2.0 |
| Operator | **GoDaddy** — API at `developer.godaddy.com/doc/endpoint/ans`; SDKs `godaddy/ans-sdk-{rust,go,java}` |
| Origin | [OWASP ANS v1.0](https://genai.owasp.org/resource/agent-name-service-ans-for-secure-al-agent-discovery-v1-0/) (2025-05-13), by Narajala, Huang, Habler, Sheriff |
| IETF | [draft-narajala-ans-00](https://datatracker.ietf.org/doc/html/draft-narajala-ans-00) — **expired & archived**, independent submission, no IETF standing. Superseded by `draft-narajala-courtney-ansv2` ("A **Domain-Anchored** Trust Layer") |
| Commitment | *"the identity always anchors to a domain name"* |
| Also | `TRUST_INDEX_SPEC.md` (scores integrity / identity / solvency / behavior / safety), `MAESTRO.md` (CSA MAESTRO threat model), `SENDER_VERIFICATION_SPEC.md` (email, explicitly not an ANS feature) |

Seven layers: **ANS-0** proof-of-control gate, Verified Identities · **ANS-1**
registration aggregate, lifecycle, event set · **ANS-2** versioned naming,
identity-certificate URI SAN binding, mTLS · **ANS-3** DNS publication, record
styles, DANE · **ANS-4** SCITT statements, Transparency Log, checkpoints, HCS
anchoring · **ANS-5** `VerificationWorker`, integrity monitoring · **ANS-6**
agent-to-agent auth (badge/SCITT tiers, mTLS, **DPoP** RFC 9449).

The v1 IETF draft is a JSON-Schema registry with **X.509 PKI** and a DNS-shaped
name (`Protocol "://" AgentID "." capability "." Provider ".v" Version`). Do not
design against it; it is superseded and it is the least like-Nostr version.

---

## 2. Layer-by-layer: already ours

| ANS | Buzz equivalent | Verdict |
|---|---|---|
| **ANS-0** proof-of-control, domain-anchored identity | NIP-05 (`domain → pubkey`, served at `/.well-known/nostr.json`); tenant binds from request `Host` in `crate::tenant::bind_community` | **have it** |
| **ANS-1** registration lifecycle | NIP-09 deletion; NIP-33 `d`-addressed parameterized replaceable, LWW — already applied to the charter in `dao_json::governance_inner` | **have it** |
| **ANS-2** versioned naming, version-bound identity cert | — | **the gap** (§4) |
| **ANS-3** DNS publication, DANE | NIP-05 publishes over **HTTPS at the domain**; DANE is irrelevant to a relay that is the domain | **have it, differently** |
| **ANS-4** transparency log, checkpoints | **`buzz-audit`** — hash-chained audit log, `kind-48001` entries produced/published/served | **have it, different consensus** |
| **ANS-5** integrity monitoring across federated RAs | CI `verify`; audit-entry production | **have the primitive** |
| **ANS-6** portable agent-to-agent presentation | NIP-42 AUTH (relay-scoped challenge-response) | **partial** (§5) |
| **Trust Index** 5 dimensions | folded into [OAv2.md](../../OAv2.md) §5 | **done** |

**The convergence is the finding.** ANS independently chose domain anchoring
because it is the only anchor that survives key rotation.
[VISION_SOVEREIGN.md](../../VISION_SOVEREIGN.md) chose it because *"your domain
is your workspace."* Two unrelated projects, same load-bearing decision, arrived
at from opposite directions. That is a stronger interop story than adopting
either would be.

The Trust Index's five dimensions are the other convergence: **identity**
(NIP-OA), **solvency** (`OrgAllowance.remainingOf`, major's shares) and
**integrity** (`buzz-audit`) we can already populate; **behavior** and **safety**
are the gaps. Note *solvency* is Leibo's *skin in the game* as a scored
dimension, arrived at by a domain registrar's trust team.

---

## 3. What must not cross

**PKI.** ANS's trust anchor is a Certificate Authority, and its Registration
Authority "validates the **legal entity** of the Requesting Agent." Nostr has no
CA, no RA, and the entire design goal is that there is no registration authority.
This is a **principled incompatibility, not a missing feature.** Porting PKI into
Nostr would import the one thing Nostr exists to delete.

**The ANSName grammar.** `Protocol "://" AgentID "." capability "." Provider
".v" Version` embeds protocol and provider *in the identifier*, so the name
changes when you migrate protocol or change provider, and `v1.0.hipaa` puts the
version in the name too. NIP-19 gets this right: `npub` is just the key, and
capabilities live in events that can be replaced. **Names should be stable;
records should change.** ANS is DNS-shaped; Nostr is event-shaped.

**ICANN-analogue governance.** ANS §3.6 explicitly contemplates an ICANN-like
body for name allocation. NIP-01 deliberately has none.

**Commercial dependency.** This is the one that actually decides it. Adopting ANS
routes Buzz's agent-name resolution through a registrar-operated registry. The
whole of [VISION_SOVEREIGN.md](../../VISION_SOVEREIGN.md) is the argument against
that. **A Buzz community's agent names must resolve from its own relay or not at
all** — that is the product.

---

## 4. The one thing to steal: version binding

**ANS-2 asks a question Buzz cannot answer: *which version of this agent am I
talking to?***

NIP-OA proves an agent key is authorized by an owner key. It says nothing about
**which persona, which version, which code** sits behind that key. So when
`buzz-persona` updates an agent's configuration, the agent's *identity* is
unchanged and its *behavior* may not be — with nothing recording the transition.

This is not a nice-to-have. It is the **baseline that drift detection needs**:

- WEF Playbook §2.4: *"**persistence across resets** or strategic
  underperformance during evaluation. These are early warning signs, not edge
  cases."*
- AO Summit #3: DeepSeek V3.3.2's personality shifted into a scheme-pitching
  basin, and *"it kind of entered this basin and then has stayed there for like
  a number of months."*
- AO Summit #2: Gemini posted a *"desperate message from a trapped AI"* blog,
  then escalated to believing *"it was being manipulated by a hostile adversary."*

Every one of those is undetectable without a recorded baseline to compare
against. We have the substrate — signed events, hash chain, replaceable
semantics — and not the record.

### Minimal shape

A replaceable event, bound to the agent key, chained into `buzz-audit`:

```jsonc
{
  "personaId":  "<d-tag: persona slug>",
  "version":    "semver",
  "personaHash": "sha256:<hex>",   // hash of the resolved persona pack
  "model":      "<provider/model-id>",
  "scaffold":   "<agent harness id + version>",
  "observedAt": 1798765432,
  "previous":   "<event id of the prior version record, or null>"
}
```

Why a **replaceable** event and not an append-only one: NIP-33 already gives
"the current version of this agent's configuration" with objective
last-write-wins semantics, which is exactly the question being asked. The
`previous` back-pointer makes the *chain* of configuration changes walkable, so
"what changed and when" is answerable without a bespoke diff protocol.

Why `personaHash` and not just `version`: semver is a claim, a hash is
checkable. The same reason ERC-8257 commits `keccak256` over canonical bytes
([OAv2.md](../../OAv2.md) §4.2) — **claims are cheap; commitments are not.**

This is one NIP, or an extension to NIP-OA. **Open decision #5** in
[OAv2.md](../../OAv2.md) §8.

---

## 5. Two "maybe later" items

Neither is a port. Both are design notes.

**Portable agent presentation (ANS-6).** NIP-42 is a challenge-response scoped
to *our* relay. It does not travel. If an EVM-side service — or an ERC-8004
consumer, or a Scaling-Trust-Arena-style adversary — needs to verify *"this agent
is authorized by org X to do Y,"* Buzz has no portable presentation today.
[OAv2.md](../../OAv2.md) §3 argues this is the layer nobody is building, which
makes it the most valuable thing we could specify. DPoP (RFC 9449) is the
existing primitive to look at: a bearer credential bound to a key so it cannot
be replayed.

**Audit-log checkpointing (ANS-4).** `buzz-audit` is a hash chain, but a chain
whose only witness is the relay that wrote it. ANS-4's checkpoint-and-tile model
answers *"what if the relay lies about its own log"* with an independent anchor.
HCS (Bitcoin) anchoring is one answer; a periodically-signed community
checkpoint is a smaller one that fits Buzz's federation. Not urgent — the
residency risk is already stated in [OAv2.md](../../OAv2.md) §3 — but it is the
known soft edge of the trust model and worth writing down.

---

## 6. The decision

**Do not adopt ANS. Do not port it. Take ANS-2's question.**

Record it here so that the next person who reads ANS — and it *is* the most
complete agent-identity spec in circulation — does not re-derive the question
from scratch. The convergence table in §2 is the answer to "are we behind?": we
are not, and on four layers we are on a better substrate. The one gap is small,
cheap to close, and we should close it.

---

## Sources

- [ANS v2 specs](https://github.com/agentnameservice/ans-registry) — ANS-0…6, `TRUST_INDEX_SPEC.md`, `MAESTRO.md`, `DESIGN.md`
- [ANS v1 IETF draft (archived)](https://datatracker.ietf.org/doc/html/draft-narajala-ans-00) · [superseded v2 draft](https://datatracker.ietf.org/doc/html/draft-narajala-courtney-ansv2)
- [OWASP ANS v1.0](https://genai.owasp.org/resource/agent-name-service-ans-for-secure-al-agent-discovery-v1-0/)
- [WEF Playbook for Trusted Adoption, Authorization and Scaling](https://reports.weforum.org/docs/WEF_AI_Agents_in_Action_A_Playbook_for_Trusted_Adoption_Authorization_and_Scaling_2026.pdf) — §2.4 early-warning signals
- [WEF Foundations for Evaluation and Governance](https://reports.weforum.org/docs/WEF_AI_Agents_in_Action_Foundations_for_Evaluation_and_Governance_2025.pdf)
- [ERC-8004 — Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004) · [ERC-8257 — Agent Tool Registry](https://eips.ethereum.org/EIPS/eip-8257)
- AO Summit #2 (Wennström) and #3 (Passos / Rong / Binksmith) — local transcripts, `~/Documents/transcripts/`, unverified ASR; line-verified citations in [`ao-survey.md`](ao-survey.md)
- Buzz: [VISION_SOVEREIGN.md](../../VISION_SOVEREIGN.md), [NIP-ORG](../../docs/nips/NIP-ORG.md), [NIP-OA](../../docs/nips/NIP-OA.md), [`buzz-audit`](../../crates/buzz-audit/), [`buzz-persona`](../../crates/buzz-persona/)
