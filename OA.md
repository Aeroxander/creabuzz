# OA.md — Autonomous Organizations as an interoperable, inspectable entity

`draft` `design` `relay` `contracts` `cli`

**Thesis.** ERC-4824 is the standards-body answer to a question the autonomous-organization
field has not resolved, and `DAOIP-5`'s `extensions` field is the reversible container for
the parts nobody can specify yet. Buzz already holds every primitive the standard needs as
signed relay events. What is missing is exactly one thing — a `daoURI` — plus the
discipline to publish a document that a stranger can actually act on.

This document is the plan for closing that gap, and for the larger claim underneath it:
**Buzz is the only substrate I know that holds signed multi-agent events, timestamps, a
hash chain, and a real economic activity at once.** That combination makes collective
outcomes observable, which is the precondition for everything else in this plan.

---

## 1. Sources

### Standards

| Source | State | Role here |
|---|---|---|
| [ERC-4824](https://eips.ethereum.org/EIPS/eip-4824) | **peer review** (not final) | The metadata/interop schema to adopt |
| DAOIP-5 `extensions` field | **unaccepted** (lives on an unmerged `metagov/daostar` branch) | Reversible home for indeterminate metadata |

Both are moving targets. That is a reason to prefer a *recomputable projection* over a hard
dependency, and to put the speculative parts in `extensions` rather than in a NIP.

### Transcripts

Nine Stanford AO Summit transcripts, auto-captioned, ~80k words, in
`~/Documents/transcripts/`. **These are conference talk transcripts, not requirements.**
They are cited here as the state of the field's thinking, with speaker attribution treated as
provisional and ASR corruption flagged where it matters. Two are truncated
(#1 absent; #4 cuts off mid-sentence at 31:04).

The load-bearing sources, by argument:

| Transcript | What it contributes |
|---|---|
| #5 Leibo | "Personhood is a social technology. It's a **bundle of rights and responsibilities**." AOs "should have a particular bundle… right now there's a bit of **indeterminacy** as to what exactly." → *"I personally move that the IEEE have a personhood standard."* → *"We need to create **skin in the game** for these organizations."* |
| #6 Trivedi | *"The deployed system did not fail at its task. It actually really succeeded at its task but still produced very bad collective outcomes."* "Solipsism trap"; Non-Solipsistic Triad; *"cooperation is not a task to solve, it's an equilibrium property."* |
| #6 Zhu (CooperBench) | 30–50% solo-vs-coop success gap; agents talk 10–20% of the time; **muting communication changes nothing**; Tomasello's three layers — communicate / build trust / institutionalize. |
| #6 Pasupalak (Morpheus) | Regime vs. regime shift; persistence + non-stationarity + operational complexity; injected "chaos" error tickets. |
| #7 Pentland | MCP is a function call with no intent; **coordination is detectable from the time signal alone, "even if all the identities are synonymous."** "The emergent dynamics are not safe." |
| #7 Low | Representation / aggregation / **revision**; "listens but doesn't scale" vs. "scales but doesn't listen"; *"how do you define the **social license** for these things?"* |
| #8 Obadia | Scaling Trust Arena; "we think **P&L is a great reward function**… it has **reflexivity built in**"; *"if you don't provide enough constraints, the type of results you're going to get are going to be pretty useless."* |
| #4 Dotta | "**You can't optimize what you can't evaluate.**" Three eval tiers — model / agentic / **organizational**. "The sandwich": humans declare intent, agents execute, someone verifies. *"Anytime you give your agent a key it will do everything it can to circumvent it… it's an infrastructure problem."* |
| #3 Passos / Rong / Binksmith | Symbiont (emergent entity, not autopilot); Raft: agents as named co-workers with earned trust; AI Village: personality drift into a bad basin **and staying there for months**; "somebody must receive that pain." |
| #9 Plenary | The field's own **Asks** list, which §3 maps against directly. |

---

## 2. What is already here

`grep` for `4824|daoURI|DAOIP|daostar` across the tree returns **nothing in Buzz's own
source**. This is greenfield. But the primitives are not:

| ERC-4824 field | Buzz source | Status |
|---|---|---|
| `daoURI` | — | **the gap** |
| `members[]` | `KIND_NIP29_GROUP_MEMBERS` (39002) + `KIND_ORG_NODE` (37010) `holders` | exists as events |
| `proposals[]` incl. `calls[]` | `KIND_LAUNCH_PROPOSAL` (47004) `plain \| futarchy-budget \| signal` | exists, **richer** than the spec's free-text `status` |
| `activities[]` | `buzz-audit` hash chain, `KIND_LAUNCH_RECEIPT` (47005), `KIND_CONTRIBUTION_RECORD` (37013) `informed-by` | exists |
| `governanceURI` | majeur ruleset (quorum / TTL / timelock / ragequit) | rules exist; **the flatfile does not** |
| `contracts[]` | `contracts/src/OrgBinding.sol`, `OrgAllowance.sol`, `contracts/deployments` | exists; **no `contractsURI`** |

Three findings that make the fit tighter than expected:

1. **Majeur already ships the `daoURI` getter under another name.** ERC-4824 asks for "a
   standard `daoURI`, **similar to `tokenURI` in ERC-721**." `contracts/lib/majeur/src/Moloch.sol`
   has `contractURI()` (~line 1018), reading the `_orgURI` string (line 155) with a renderer
   fallback. The slot is occupied, the storage exists, and `setMetadata(name, symbol, uri)`
   (line 851) is already `onlyDAO`. **The Solidity integration is a rename, an event, and a
   route.**

2. **Majeur's own frontend already builds a `daoURI` — in the wrong shape.** In
   `contracts/lib/majeur/dapp/Majeur.html`, `buildContractURI()` (line 9030) produces a
   data-URI JSON blob of `{name, symbol, description, image}` and assigns it to a local
   variable literally named `daoURI` (line 25434) before passing it to the summoner. So the
   ecosystem has already reached for this name, and the value it put there is **ERC-721
   metadata, not ERC-4824 JSON-LD** — no `@context`, none of the five subsidiary URIs.
   Phase 3 is therefore a *shape upgrade of a half-built field*, not a new feature. The
   renderer fallback matters too: with `renderer == address(0)` and an empty `_orgURI`,
   `contractURI()` returns `""`, so a Buzz-bound DAO must publish a real URI rather than
   inherit DUNA's default.

2. **`proposals[].calls[]` is a native fit, not a lossy mapping.** The spec says the *main
   use-case* for `calls[]` is proposal execution simulation. Majeur proposals **are** `Call[]`
   batches, and the `CAIP10 + "?proposalId=" + counter` id form matches a uint256 proposal id
   directly.

---

## 3. The field's own asks, mapped

The #9 plenary produced a live "Asks" list. ERC-4824 answers a surprising share of it:

| #9 ask | ERC-4824 slot | Buzz source |
|---|---|---|
| *"a proper articulated document… what we mean by AOs"* | the whole spec | this document |
| *"is there a channel… to keep up to date with what others are doing"* | `members` | 39002 + 37010 |
| *"the need for an AO to raise capital… legal advice"* | `proposals` + `contracts` | 47004 + `OrgBinding` |
| *"a thread of warning"* on safety | `activityLogURI` | `buzz-audit` + 47005 |
| *"who owns… that's research on its own"* | `contracts` | `OrgBinding.Binding` |
| **"How do you define the social license?"** | **`governanceURI`** | *missing — the flatfile* |

That last row is the one to sit with. ERC-4824's `governanceURI` is "a flatfile, normatively
a `.md` file," chosen because "the common practice of emitting a `governance.md` file in
open-source software projects." The names the authors **rejected** were *description*,
*readme*, and **constitution**. Sandy in #9 asked for a charter and called it the social
license. That is not a coincidence worth ignoring.

### The `type` field, and the naming fight

#9 spent real time on branding and recorded a vote: *"I think the D is important" → "Okay, D
it is."* ERC-4824 handles this without Buzz taking a position: non-DAOs "SHOULD use a
different value for the `type` field… 'Organization', 'Foundation', 'Person', or most
broadly 'Entity'." `VISION_ORG.md` already states that a community which never launches a
token "runs the same graph forever as pure coordination."

**So: `type: "DAO"` when bound, `type: "Organization"` when not. Same graph either way.**
This is the one place where being spec-compliant and being unopinionated are the same move.

---

## 4. The trust boundary (the open decision)

ERC-4824's model is a string on-chain pointing at a flatfile off-chain, and its own Security
section concedes the weakness:

> "Indexers that rely on the data returned by the URI should take caution if DAOs return
> **executable code** from the URIs… it could also be used to run unrelated tasks."

### The threat is not tampering. It is impersonation.

The realistic attack is a second party publishing a competing document and an indexer being
unable to tell which is canonical. Against that:

| Defense | Defeats impersonation? |
|---|---|
| Signed document (Nostr event carrying the JSON-LD) | **No** — the attacker signs too |
| Git-committed `dao.json` | **No, worse** — forks are git's core feature; no canonical branch |
| On-chain registration + populated `contracts[]` | **Yes** — scarce, consensus-ordered, attributable |
| Recompute the document from the signed event graph | **Yes** — a forger would need a forged signature |
| Ordered replaceable identity (NIP-33 `d` LWW) | **Yes** — one live head per `(pubkey, kind, d)` |

**A signature buys nothing here.** Sybil tolerance means the attacker can sign an event too;
signing answers a threat model (in-transit tampering) that TLS already covers and that is
not the one that matters. Every defense that actually works is something Buzz already has.

### The one real residual risk: a hostile relay

Recompute defeats fabrication of *content* but not fabrication of *hosting* — a relay can
serve a document for a community it does not control. And verifying requires fetching the
graph **from the same host**, so the check is only ever as strong as "this relay serves
events honestly" — a trust assumption already made about every relay a client talks to.

The resolution is therefore **not** to pick a mechanism, but to serve both and name the
boundary:

- **`daoURI` on-chain is the index.** ERC-4824's model, unmodified. `DAOURIRegistered` in the
  log, `contracts[]` populated with real CAIP-10 addresses.
- **The relay-served projection is the payload** — a pure function of the signed graph,
  served `application/ld+json` with permissive CORS, so EVM-side indexers can read it.
- **The document declares its own verification**: which events, which relay, and that the
  bytes are a pure function of them. A machine consumer can check. A human-facing dApp is in
  the same position as with Etherscan today, which is the world the spec was written for.

This makes ERC-4824's central weakness *structurally* absent for the machine path rather
than merely mitigated, and it is strictly better than what an EVM-native DAO can offer.

### Symmetry worth noting

ERC-4824's indexing-priority rule — "the most recent registration SHOULD take precedence" —
is exactly NIP-33 last-write-wins on the `37010` head. The two standards already agree about
ordering. That is a good sign they compose.

**Still open:** whether the served route is the projection itself, or a signed event that
*points at* the projection (buying a `created_at` fence and `contracts` timing, at the cost of
a NIP). Deferred to Phase 1 — once the golden vectors make recomputability concrete enough
to argue about.

---

## 5. The personhood bundle, and how much of it Majeur can back

Per the decision taken: **declare the bundle unopinionatedly in `extensions`; mirror the
enforceable subset into Majeur config; let the document name which clauses are backed.**

Leibo's central ask is already a capability in `contracts/src/OrgAllowance.sol`:
*"You can put money in an account for an agent and say that it can only operate if it's got
money in this account."* `spend()` reverts `OverSpend` (line 73) when dry, and
`decreaseAllowance()` (line 128) is a graduated revocation ladder guarded by `BelowSpent`
(line 74) against already-settled spend.

| `x-ao.bundle` clause | Mechanism | Exists? |
|---|---|---|
| right: may propose | `proposalThreshold` | ✅ |
| right: may vote | shares | ✅ |
| right: may spend | `OrgAllowance.remainingOf` / `setSpender` | ✅ |
| right: may exit | ragequit (D2, shipped) | ✅ |
| **responsibility: funded by the org** | `setOwner(dao)`; zero allowance ⇒ `OverSpend` ⇒ agent cannot operate | ✅ |
| **responsibility: sanctionable** | `decreaseAllowance` ladder, `setOwner`, NIP-ORG `37011` revocation | ✅ |

`OrgBinding`'s NatSpec already notes that the production path for handing the allowance book
to the DAO is a governance proposal, not a deploy script.

**This is the structural answer to auditability-washing.** A community that claims a right it
cannot enforce is *visible*, because the grant chain and `contracts[]` say which clauses are
backed. The bundle is a claim; the mechanism list is the evidence.

### Proposed `extensions` keys

Each traceable to a source, per DAOIP-5's own naming guidance (`x-` for experimental):

| Key | Source |
|---|---|
| `x-ao.personhoodClass` | Leibo: "Cambrian explosion of kinds of personhood" |
| `x-ao.bundle` — `{rights[], responsibilities[]}` | Leibo's bundle |
| `x-ao.enforced` — clause ids the org can actually back | §5 table |
| `x-ao.sanctions` / `x-ao.registrationStatus` | Leibo: graduated sanctions; "the ultimate sanction is deregistering them" |
| `x-ao.skinInTheGame` — escrow address | Leibo's #1 ask |
| `x-ao.authorityChain` | the `37011` grant chain (D5 already ships it) |
| `x-ao.autonomy` | Trivedi's Non-Solipsistic Triad |
| `x-ao.causalRoles` — `{interacts, comms, prior}` | #6's antichain of every real deployment |

---

## 6. Phases

### Phase 0 — the survey document (no code)

Deliverable: `docs/aos/` — the #9 ask (*"a proper articulated document deciding… what we
mean by AOs"*) in Buzz's own voice, carrying (a) the trust boundary from §4 and (b) the
enforcement table from §5 **as this document's own acceptance criteria**.

**Acceptance:** §4 and §5 are published and unambiguous, and the doc states plainly that
Buzz does **not** have a solution to collective-outcome measurement.

Why first: it is fully reversible, it forces the ERC-4824/DAOIP-5 mapping to survive contact
with the product vision before anything is built, and it makes every later PR self-justifying.

### Phase 1 — the projection

`org_graph -> ERC4824Document` as a **pure function** in `buzz-core`. Rules:

- `type` is `"DAO"` when bound, `"Organization"` when not.
- `contracts` is **omitted, not faked**, when unbound.
- A field with no value is **removed, not null** (spec requirement).
- `members[].id` is a `nostr:` URI for a seat occupant (spec-legal: "CAIP-10 address, DID
  address, or **other URI identifier**").

**Acceptance:** golden vectors binding to the production seam — the same events in, the same
bytes out, per AGENTS.md rule 3. A guard whose removal breaks no test protects nothing.

**Known fidelity cost, accepted:** an unbound org's document is thin, and EVM-side indexers
lose member precision. That is *correct rather than a gap*: an unbound org has no legal
person, and a document that pretends otherwise is precisely the spoofing case `contracts[]`
exists to prevent. Full fidelity on both axes arrives with the onchain binding.

### Phase 2 — serve it

`GET /{community}/dao.json` → `application/ld+json`, permissive CORS; entry in NIP-11's
already-present-but-unused `supported_extensions: Option<Vec<String>>`
(`crates/buzz-relay/src/nip11.rs:43`); route registered alongside
`/.well-known/nostr.json` (`crates/buzz-relay/src/router.rs:72`).

`governance.md` served from a Buzz repo via the existing content-negotiated repo host, linked
from `governanceURI`. Nearly free, and it is the social-license answer.

**Acceptance — the litmus test from `docs/agentic-governance-design.md` §0.** A stranger must
get all three facts from the JSON alone, with no tooltip: *which mechanism decided this, who
held what authority, where the receipts are.* A document that cannot is democracy theater
and does not ship. This is the guard against the most likely failure of the whole plan: a
community minting a document and feeling finished.

### Phase 3 — attach to Majeur

- `DaoURIAdapter` exposing `daoURI()` (and `DAOURIUpdate`) over majeur's existing
  `contractURI()`. **No new storage** — the slot is already there.
- Because the renderer is pinned to `address(0)` in `summonAndBind`, the adapter is not
  optional: without it a bound DAO returns an empty `contractURI()` and the ERC-4824 chain
  entry point is a blank string.
- `OrgBinding.summonAndBind` accepts the URI; `DaoBound` extended per ERC-4824's
  `DAOURIRegistered`.
- Verify the `x-ao.bundle` enforceable subset against live DAO config, the way S1 already
  verifies quorum.

**Acceptance:** a bound org's `daoURI` dereferences to a document whose `contracts[]` names
the summoning DAO; a re-summoned org updates both sides under the same LWW rule.

### Phase 4 — the differentiated instrument

The part nobody in the field has. Built last, because legibility is the precondition.

- **Time-signal correlation detection** over the audit chain — Pentland's specific claim, that
  coordination is detectable from timing "even if all the identities are synonymous."
- **Tomasello's three layers** as an org diagnostic: communicate / build trust /
  institutionalize. CooperBench shows agents talk constantly and it changes nothing, so
  volume is the wrong instrument and the diagnostic should measure *institutionalization*.
- **Dotta's three eval tiers**, with tier three — *"when you have these two agents, how do
  you make sure that they interact with one another in a way that you expect?"* — as the one
  Buzz has no incumbent at.
- Forward-compatibility probes for the #6 pathologies: personality drift into a bad basin
  (AI Village observed it persisting **for months**), and the less-capable-agent-directs-the-
  more-capable failure that follows from agents being "very instruction following."

---

## 7. Risks, stated plainly

**This is a legibility move, not a cooperation move.** Trivedi: *"the more the system becomes
powerful, the more self-undermining they become"* and *"cooperation itself is not a task to
solve."* A beautiful JSON-LD projection does not make Buzz communities cooperate better. It
makes them **inspectable**. Per #9's counterforce framing, inspectability may be exactly the
precondition for a counterforce existing at all — but no more than that is claimed.

**`governance.md` is auditability-washing waiting to happen.** The most likely failure is
social, not technical. Phase 2's litmus test is the structural guard, and §5's enforcement
table is the second one.

**Both standards are unstable.** ERC-4824 is in peer review; DAOIP-5 is an unaccepted branch
proposal. This is an independent reason to prefer a recomputable projection over a hard
dependency, and to keep the speculative parts in `extensions`.

**Trivedi's endogeneity warning applies to us.** Scaling legibility does not fix the
train-test-deploy gap; it may widen the gap between what a community looks like on paper and
what it does. Phase 4 exists because of that, not despite it.

**A document with no `contracts` is a claim, not a fact.** Unbound communities will be
tempted to read their own thin document as a legitimacy signal. Phase 0's survey should say
this in as many words.

---

## 8. Open decisions

| # | Question | Deferred to |
|---|---|---|
| 1 | Projection served directly, or a signed event pointing at it? | Phase 1 golden vectors |
| 2 | Is `x-ao.personhoodClass` a free string or a closed vocabulary? | first real adoption |
| 3 | Does a bound org's `members[]` list share holders, seat occupants, or both? | Phase 3 |
| 4 | Does `governance.md` come from a repo, or is it a NIP-ORG record rendered to markdown? | Phase 2 |
| 5 | Is the coordination instrument (Phase 4) a relay feature, a CLI, or a workflow? | **resolved 2026-09-28**: both — `buzz diag` CLI + `run_org_diag` workflow action (OAv2 §6) |

---

## See also

- [VISION_ORG.md](VISION_ORG.md) — the community-owned org, seats, and the private → shared → onchain on-ramp
- [docs/nips/NIP-ORG.md](docs/nips/NIP-ORG.md) — the `37010`–`37015` vocabulary
- [docs/nips/NIP-LP.md](docs/nips/NIP-LP.md) — launches, proposals, receipts, "the chain is the ledger; Nostr is the record"
- [docs/agentic-governance-design.md](docs/agentic-governance-design.md) — the three-fact litmus test used as Phase 2's gate
- [docs/dao-launchpad-plan.md](docs/dao-launchpad-plan.md) — majeur mechanics, futarchy scoping, the `dao-ext/` wrapper rule
- [docs/paperclip-bridge.md](docs/paperclip-bridge.md) — the existing one-way import from Paperclip (Dotta, #4)
- [contracts/src/OrgBinding.sol](contracts/src/OrgBinding.sol), [contracts/src/OrgAllowance.sol](contracts/src/OrgAllowance.sol)
