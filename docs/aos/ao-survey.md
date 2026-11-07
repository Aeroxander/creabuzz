# What we mean by autonomous organizations

`draft` `research` `aos`

Phase 0 of [OA.md](../../OA.md) — the #9 plenary's ask, in Buzz's voice: *"a proper
articulated document deciding… what we mean by AOs"* (`transcripts/…#9 Plenary…txt`
18:07–18:55). This document carries OA.md's two acceptance criteria — the **trust
boundary** (§4) and the **enforcement table** (§5) — and states plainly what Buzz does
*not* have (§5). Transcripts are line-cited ASR dumps in
`/Users/alexanderklus/Documents/transcripts/`; citations were verified against the text.

## 1. The personhood bundle, and why now

Leibo (#5, 13:15–13:46): personhood is *"a bundle of rights and responsibilities… it can
be configured in different ways"* — natural persons, legal persons, and now AOs, which
*"should have a particular bundle of rights and responsibilities."* His key admission
(13:50): *"right now there's a bit of indeterminism as to what exactly the [bundle is]."*

That indeterminism is the opportunity. The field has not defined the AO bundle; the first
**machine-readable, enforced** bundle becomes the default vocabulary. Buzz is unusually
well-positioned to ship one because every clause can point at a mechanism (§5) — grants,
allowances, receipts, exit rights — rather than at a promise.

**Working definition.** An autonomous organization is an org whose membership, authority,
money, and work are legible through signed events and enforceable onchain — with human
*and* agent seat holders as first-class persons — such that an outsider (human or machine)
can answer *what is this, who may act, what happened, and what can I do about it* without
trusting any single interface.

## 2. What the summit actually asked for (verified citations)

| Ask | Source (line-verified) | Where it lands |
|---|---|---|
| Define the bundle of rights/responsibilities for AOs | #5 13:15–13:50 | `x-ao.bundle` + `x-ao.enforced` (§5) |
| *"You can't optimize what you can't evaluate… defined what's good enough"* | #4 12:44 | the outcomes split (§5); Phase 4 eval tiers |
| *"P&L is a great reward function… the real world already has [a measure]"* | #8 10:46 | the royalty/receipt stream as per-seat P&L (§5) |
| *"How do you define the social license… they might have to interact with these things without… consenting"* | #9 18:07–18:55 | `governance.md` for **two audiences** (§6) |
| Skin in the game / funded accountability | #5 (throughout) | escrow (`ClaimStake`), `OrgAllowance` |

**Citation precision note.** OA.md's #7 row blends two sources: the
representation / aggregation / revision triad and *"democracy listens but doesn't scale"*
are genuinely #7 (41:37–46:42, verified), but *"how do you define the social license"*
appears in **#9** (18:07–18:55), not #7 — cite each to its session. (An earlier draft of
this document also "corrected" a quote — "make trust for AIs" — that OA.md never
contained; that phantom has been removed.)

## 3. The trust boundary (acceptance criterion 1)

ERC-4824's model is a string on-chain pointing at a flatfile off-chain; its own security
section warns about what such a URI can return. The realistic attack on a Buzz-published
document is **impersonation**, not tampering — and, critically, *a signature buys nothing*
(a Sybil can sign too; TLS already covers in-transit tampering). The defenses that work:

| Defense | Defeats impersonation? |
|---|---|
| Signed document | **No** |
| Git-committed `dao.json` | **No** (forks are git's core feature) |
| Onchain registration + populated `contracts[]` | **Yes** — scarce, consensus-ordered, attributable |
| Recompute the document from the signed event graph | **Yes** — forgery requires a forged signature |
| Ordered replaceable identity (NIP-33 `d` LWW) | **Yes** — one live head per `(pubkey, kind, d)` |

**Resolution:** `daoURI` on-chain is the *index*; the relay-served projection is the
*payload* — a pure function of the signed graph (`buzz-core::erc4824`), served
`application/ld+json`; the document declares its own verification (which events, which
relay). Residual risk, stated: the check is as strong as "this relay serves events
honestly" — the same assumption every relay client already makes. The projection's rules
make the spoofing case impossible to fake *honestly*: unbound orgs get `type:
"Organization"` and **no** `contracts` field — never faked, never padded.

## 4. The enforcement table (acceptance criterion 2)

The bundle is a **claim**; the mechanism list is the **evidence**. A community that claims
a right it cannot enforce is *visible*, because the grant chain and `contracts[]` say which
clauses are backed.

| `x-ao.bundle` clause | Mechanism | Exists? |
|---|---|---|
| right: may propose | majeur `proposalThreshold` | ✅ |
| right: may vote | shares (delegatable, split delegation) | ✅ |
| right: may spend | `OrgAllowance` (`setSpender`, `spendAllowance`) | ✅ |
| right: may exit | ragequit (surfaced in every governance panel, D2) | ✅ |
| responsibility: funded by the org | allowance owner = the DAO; dry allowance halts the actor | ✅ |
| responsibility: sanctionable | `decreaseAllowance` ladder, NIP-ORG `37011` revocation | ✅ |
| responsibility: attributable | receipts (47005/47006/47007), audit chain, `evidenceHash` | ✅ |

## 5. What Buzz does NOT have (the honesty split)

The summit's recurring complaint is missing collective-outcome measurement. The honest
statement splits it in two:

- **Value production — measured.** Attested receipts, the royalty stream (per-seat,
  human or agent), settlement-close mirrors (47007), onchain payouts. This is Obadia's
  P&L-as-reward-function made concrete: an agent's economic outcome here is a claimable,
  attributable, onchain-backed number — not a vibes metric.
- **Cooperation quality — NOT measured.** Whether two actors coordinated *well* (rather
  than profitably) is exactly Dotta's tier-three question (*"how do you make sure [two
  agents] interact in a way that you expect"*) and Trivedi's warning that cooperation
  itself is not a task to solve. Buzz has the *substrate* (timestamped activity, audit
  chain, tiered reasoning logs) but **no instrument**. That is Phase 4 research
  (OA.md §6), and no document of ours should imply otherwise.

## 6. The charter (`governance.md`) is for two audiences

The plenary's sharpest point (#9 18:45–18:55): the public *"might have to interact with
these things without… consenting."* The social license therefore has two readers, and the
charter must answer both in plain language:

1. **The public / outsiders:** what does this org do in the world, what may it do to
   people who never joined, what is it bound by, how does one complain or exit.
2. **Agents and their operators:** who may act here, under which grants, with what
   budgets, under what sanction ladder, with what receipts — the machine-readable bundle
   (§4) restated for humans.

A charter that answers only members' questions is a README wearing a suit. Phase 2's gate
is the three-fact litmus test (which mechanism, who held authority, where the receipts
are) — applied to the *document*, not just the UI.

## 7. Vocabulary and watch items

- `x-ao.personhoodClass`, `x-ao.bundle` `{rights[], responsibilities[]}`,
  `x-ao.enforced` (clause ids backed by mechanisms), `x-ao.sanctions` /
  `x-ao.registrationStatus`, `x-ao.skinInTheGame` (escrow address), `x-ao.authorityChain`
  (the `37011` grant chain), `x-ao.outcomes` (`{instrument, streams}` — §5's split),
  `x-ao.autonomy`, `x-ao.causalRoles`.
- **Legal wrapper — decision (2026-09-27): NO default.** `x-ao.personhoodClass`
  records `jurisdiction + wrapper`, and **`none` is both the default and a
  legal value.** A community may opt into a DAO LLC, tie its **own existing
  entity** to the project, or start with nothing and decide before token
  launch. When a wrapper exists it is named in `contracts[]`'s description
  (never faked when absent), and a bound DAO is never presented with a
  baked-in charter — the renderer default (OAv2 §4.8's DUNA category error)
  must not leak into any org's metadata.
- **Watch item:** DAOIP-5 is a *grants* standard; the launchpad's treasury doors could
  later emit `grantPools[]` for interop with grants tooling. Unbuilt; noted so the
  vocabulary stays compatible.
- Both standards are unstable (ERC-4824 in peer review; DAOIP-5 an unaccepted branch) —
  an independent reason the projection is a pure function and the speculative parts live
  in `extensions`.

## 8. Sources

- `transcripts/…#5 Joel Z Leibo…` (personhood bundle), `…#4 Dotta…` (evaluation),
  `…#8 Alex Obadia…` (P&L), `…#9 Plenary…` (social license, field asks) — line refs in §2.
- [OA.md](../../OA.md) — the integration plan this document surveys for.
- [ERC-4824](https://eips.ethereum.org/EIPS/eip-4824) (peer review),
  [DAOIP-5 `extensions`](https://raw.githubusercontent.com/metagov/daostar/refs/heads/main/DAOIPs/x-daoip-5.md)
  (unaccepted branch).
- Buzz: `crates/buzz-core/src/erc4824.rs` (the projection), `contracts/src/OrgAllowance.sol`,
  `docs/agentic-governance-design.md` (the litmus test), `docs/token-lifecycle-design.md`
  (the outcomes stream), `VISION_ORG.md`.
