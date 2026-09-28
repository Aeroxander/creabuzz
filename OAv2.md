# OAv2.md — Autonomous Organizations as an interoperable, inspectable entity

`draft` `design` `relay` `contracts` `cli`

**v2 of [OA.md](OA.md).** Phases 0–2 are built. This revision folds in a
second reading round — two WEF papers, three EIPs, the ANS spec, and three
adjacent projects — which **changes the map and forces ten corrections on the
built code.** Those corrections are §4. Everything is sourced in §1.

The thesis has not moved: **ERC-4824 is the standards-body answer to a question
the field has not resolved, `extensions` is the reversible container for the
parts nobody can specify yet, and Buzz already holds every primitive the
standard needs as signed relay events.** What has changed is that the
surrounding map is now complete, and it shows we are building the one layer
nobody else is.

---

## 0. Status — what shipped

| Phase | Deliverable | Where | State |
|---|---|---|---|
| **0** | The field's own definition + trust boundary + enforcement table | [`docs/aos/ao-survey.md`](docs/aos/ao-survey.md) | built, with verified transcript line-citations |
| **1** | `org_graph -> ERC4824Document`, a **pure** function | [`crates/buzz-core/src/erc4824.rs`](crates/buzz-core/src/erc4824.rs) | built, golden-vector tested |
| **2** | `GET /dao.json` + `GET /governance.md`, `ld+json`, permissive CORS | [`crates/buzz-relay/src/api/dao_json.rs`](crates/buzz-relay/src/api/dao_json.rs) | built, Host-bound per NIP-05 discipline |
| **2** | `calls[]` added to the `47004` proposal record | [`docs/nips/NIP-LP.md`](docs/nips/NIP-LP.md) | built |
| **2** | `erc-4824` advertised in NIP-11 | [`crates/buzz-relay/src/nip11.rs`](crates/buzz-relay/src/nip11.rs) | built |
| 3 | `DaoURIAdapter` over majeur's `contractURI()` | [`contracts/src/DaoURIAdapter.sol`](contracts/src/DaoURIAdapter.sol) | built (`daoURI()` + `DAOURIUpdate`; `test/DaoURI.t.sol`, LWW) |
| 4 | The coordination / organizational-eval instrument | [`crates/buzz-core/src/org_diag.rs`](crates/buzz-core/src/org_diag.rs) | **built** (golden-vector, integer-exact; hosts: `buzz diag` CLI + `run_org_diag` workflow action) |

Routes registered: `/dao.json`, `/governance.md`, `/{community}/dao.json`,
`/{community}/governance.md`. Tenant binds from the request `Host`; the path
community is URL shape only, so a wrong segment can neither peek nor
enumerate. Absent charter → **404, never a fake charter.**

The Phase 1 rules, each with a test binding the production seam:
`type` is `"DAO"` when bound and `"Organization"` when not · `contracts` is
**omitted, never faked**, when unbound · valueless fields **removed, not
nulled** · `members[].id` may be a `nostr:` URI (spec-legal: "CAIP-10 address,
DID address, or **other URI identifier**") · malformed `calls` yield **no
calls, never guessed ones**.

---

## 1. Sources

Everything this document rests on. Transcripts are local and unverified ASR —
see §1.4.

### 1.1 Standards

| Source | State | What we take |
|---|---|---|
| [ERC-4824 — Common Interfaces for DAOs](https://eips.ethereum.org/EIPS/eip-4824) | peer review | The metadata schema: `daoURI` → `members` / `proposals` / `activities` / `governanceURI` / `contracts` |
| [ERC-8004 — Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004) | draft, 2025-08-13 · MetaMask, ethereum.org, Google, Coinbase | Agent identity (ERC-721 + URIStorage), Reputation, Validation registries |
| [ERC-8257 — Agent Tool Registry](https://eips.ethereum.org/EIPS/eip-8257) | draft, 2026-04-17 · Engram | Tool identity, `accessPredicate`, JCS canonicalization, origin-binding |
| [DAOIP-5 `extensions` field](https://raw.githubusercontent.com/metagov/daostar/refs/heads/main/DAOIPs/x-daoip-5.md) | **unaccepted branch** | The reversible container for `x-`-prefixed experimental metadata |
| [draft-narajala-ans-00](https://datatracker.ietf.org/doc/html/draft-narajala-ans-00) | **expired & archived**, superseded | ANS v1: X.509 PKI + DNS-shaped names. Historical; do not design against |
| [agentnameservice/ans-registry](https://github.com/agentnameservice/ans-registry) | active · **GoDaddy** · Apache 2.0 | ANS v2: 7 layered specs (ANS-0…6), domain-anchored, SCITT transparency log, Trust Index — **full analysis in [docs/aos/ans-interop.md](docs/aos/ans-interop.md): do not adopt, take ANS-2's question** |
| [OWASP ANS v1.0](https://genai.owasp.org/resource/agent-name-service-ans-for-secure-al-agent-discovery-v1-0/) | published 2025-05-13 | The origin document behind both ANS drafts |
| [A2A](https://a2a-protocol.org/) · [MCP](https://modelcontextprotocol.io/) | mature | Capability description + tool transport |
| [CAIP-10](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-10.md) | stable | Account ids (`eip155:1:0x…`) |

### 1.2 WEF / Capgemini — the AI Agents in Action series

| Paper | What we take |
|---|---|
| [Foundations for Evaluation and Governance](https://reports.weforum.org/docs/WEF_AI_Agents_in_Action_Foundations_for_Evaluation_and_Governance_2025.pdf) (Nov 2025, 34pp) | The **seven classification dimensions**; autonomy ≠ automation; HITL vs HOTL; nine baseline governance mechanisms; the five multi-agent failure modes |
| [A Playbook for Trusted Adoption, Authorization and Scaling](https://reports.weforum.org/docs/WEF_AI_Agents_in_Action_A_Playbook_for_Trusted_Adoption_Authorization_and_Scaling_2026.pdf) (May 2026, 38pp) | The **ACAP** seven sections; the capability-vs-authorization thesis; the **consequential-events register**; deployment tiers L1–L3; the supervision paradox |

Both from the AI Governance Alliance / AI Global Alliance *Safe Systems and
Technologies* working group, with Capgemini. Contributors include Gillian
Hadfield (JHU / Toronto), Anima Anandkumar (Caltech), David Kanter
(MLCommons), Tom Gruber (Humanistic AI), Claude Fischer (OpenAI Policy).

The load-bearing claim, from the Playbook's foreword:

> Organizations grasp what an agent can do, but they **struggle to define what
> it should be authorized to do in context**. This gap between **capability and
> authorization** is both the central challenge to large-scale adoption and the
> rationale of this playbook.

> AI agents are advancing faster than governance — **authorization, not
> capability, is now the critical bottleneck.**

The Playbook also states what agent cards cannot do, which is what makes the
ACAP a separate instrument:

> All three [model / system / agent cards] are essential… but **none of the
> existing agent documentation helps track governance metrics, such as the
> levels of authority for a specific use case.**

### 1.3 Adjacent projects

| Source | What we take | What we reject |
|---|---|---|
| [Cursor — Agent swarms and the new model economics](https://cursor.com/blog/agent-swarm-model-economics) (2026-07-20) | Planner/worker context economics; the thrash-vs-work metrics; **licensed intentional breakage**; the Field Guide line budget | — |
| [MetaLeX vision paper](https://metalex.substack.com/p/the-metalex-whitepaper) | The MAEE idea; the interface argument | Anti-state politics; "maximize deference to code" as a first principle |
| `contracts/lib/majeur` | **Already implements the `de jure` wrapper** — Wyoming DUNA | The nonprofit default (§4.8) |
| [`Elata-Biosciences/elata-appstore`](https://github.com/Elata-Biosciences/elata-appstore) (private, MIT) | Launch-wizard decomposition: 13 steps, per-step tests, `.stories.tsx` catalog, `repair-launch-drafts` | The visual identity; token-gating; the Radix violet scale |

### 1.4 Transcripts — local, unverified, and load-bearing

`~/Documents/transcripts/` — nine Stanford AO Summit auto-captions, ~80k
words. **These are conference talk transcripts, not requirements.** ASR is
heavy; speaker attribution is provisional. #1 is absent; **#4 is truncated
mid-sentence at 31:04.** [`docs/aos/ao-survey.md`](docs/aos/ao-survey.md)
carries line-verified citations for the quotes that document depends on.

| # | Session | The argument we use |
|---|---|---|
| 2 | Axel Wennström, Lessons from Launching Some of the First AI-Run Businesses | Real-deployment bottlenecks: sycophancy, **trust injection** (not prompt injection), laziness, bad decision processes, memory/context |
| 3 | AOs in the Wild (Passos / Rong / Binksmith) | Symbiont; Raft agents-as-named-co-workers; AI Village: **personality drift into a bad basin, persisting for months**; agents inventing human slang; "somebody must receive that pain" |
| 4 | Dotta, The Self-Improving Organization | "**You can't optimize what you can't evaluate.**" Three eval tiers — model / agentic / **organizational**; the sandwich; "anytime you give your agent a key it will do everything it can to circumvent it" |
| 5 | Joel Z Leibo, A Pragmatic View of AI Personhood | "Personhood is a social technology — a **bundle of rights and responsibilities**"; the indeterminacy; **skin in the game**; "make some personabilities illegal"; judges hold authority |
| 6 | Measuring Autonomy (Trivedi / Zhu / Pasupalak / Wang) | "The deployed system did not fail at its task. It… **succeeded and still produced very bad collective outcomes**"; CooperBench's 30–50% solo-vs-coop gap and its **null communication ablation**; Morpheus's regime shifts; the grammar of coordination |
| 7 | Openness, Institutions & Society (Duettmann / Pentland / Low) | Coordination detectable from **the time signal alone, "even if all the identities are synonymous"**; representation / aggregation / **revision**; the social license; treasurer liability |
| 8 | Alex Obadia, Scaling Trust Arena | "**P&L is a great reward function**… it has **reflexivity built in**"; "if you don't provide enough constraints, the results will be pretty useless" |
| 9 | Plenary | The field's own **Asks** list, which §3 maps against directly |

---

## 2. The thesis, and what the second reading added

ERC-4824, ERC-8004 and ERC-8257 together cover **org identity, agent identity,
tool identity.** All three are drafts. None of them covers **authorization** —
attenuating, delegable, revocable authority. That is `37011`, it already ships,
and it has no EIP.

The second reading also produced the sharpest external validation available:
**"authorization, not capability, is now the critical bottleneck"** is
`VISION_ORG.md`'s claim, asserted by a WEF working group in a 38-page document.
We are not arguing against the field. We are ahead of it in one specific layer.

Two findings from the WEF Playbook land directly on the built code:

1. **The consequential-events register replaces our `x-ao.enforced`.** Section C
   wants, per event: `{action, why consequential, reversibility, required
   checkpoint, approver, escalation path}`, with authority categorized as
   *permitted / conditional / prohibited*. That is strictly more than MetaLeX's
   MAEE and more than our current clause-id list. It is also **pre-registered**
   rather than observed after the fact.
2. **`governance.md` should be a rendering, not the source.** The ACAP's own
   stated destination: *"a structured, machine-readable, **policy-as-code**
   format that enables version control, traceable change management (diffing)
   and runtime enforcement."* Our Phase 2 serves the charter from a wiki page,
   which is the right *human* surface and the wrong *source of truth.*

---

## 3. The layer map — and the three-layer hole

| Layer | Spec | Status |
|---|---|---|
| Org identity | [ERC-4824](https://eips.ethereum.org/EIPS/eip-4824) | peer review |
| Agent identity | [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) | draft, 4 major orgs |
| Tool identity | [ERC-8257](https://eips.ethereum.org/EIPS/eip-8257) | draft |
| Capability *description* | agent cards (A2A), system cards, model cards | mature |
| Name resolution | [ANS](https://github.com/agentnameservice/ans-registry) (domain-anchored, 7 layers) | active, commercial |
| **Authorization — attenuating, delegable, revocable** | **NIP-ORG `37011`** | **nothing in the EIP cluster** |
| **Evaluation / promotion gates** | ACAP Section E | **document only, no protocol** |
| **Multi-agent oversight** | WEF Foundations §3 | **document only** |

ERC-4824's own framing is that an organization has two primitives —
**membership** and **behavior** — with **proposals** relating them. All three
are Buzz's. And the three layers with no protocol are authorization,
evaluation, and oversight: **exactly the three things that make an
organization an organization rather than a pile of agents.**

The AO Summit's asks, mapped:

| #9 ask | Where it lands |
|---|---|
| *"a proper articulated document… what we mean by AOs"* | [`docs/aos/ao-survey.md`](docs/aos/ao-survey.md) |
| *"is there a channel… to keep up to date with what others are doing"* | `members` ← 39002 + 37010 |
| *"the need for an AO to raise capital… legal advice"* | `proposals` + `contracts` ← 47004 + `OrgBinding` |
| *"a thread of warning"* on safety | `activityLogURI` ← `buzz-audit` + 47005 |
| *"who owns… that's research on its own"* | `contracts` ← `OrgBinding.Binding` |
| **"How do you define the social license?"** | **`governanceURI`** — the sharpest row; see below |

ERC-4824's `governanceURI` is "a flatfile, normatively a `.md` file," chosen
because "the common practice of emitting a `governance.md` file in open-source
software projects." The names its authors **rejected** were *description*,
*readme*, and **constitution**. The #9 room asked for a charter and called it
the social license. Not a coincidence.

### The `type` field, and the naming vote

`VISION_ORG.md` already resolves the naming fight: a bound org is `DAO`, an
unbound one is `Organization` — the spec's own non-DAO clause, same graph
either way. And the room landed on *"Okay, D it is."* **Being spec-compliant
and being unopinionated are the same move here.**

---

## 4. Corrections this reading forces on the built code

Ordered by how much they matter.

### 4.1 `type` collides — 2 against 1

ERC-4824 uses `"type": "DAO"` — a **classification**. ERC-8004 uses
`"type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1"` and
ERC-8257 uses `"type": "https://ercs.ethereum.org/ERCS/erc-8257#tool-manifest-v1"`
— both **schema-version URLs**. Same field name, incompatible semantics.

**One document cannot satisfy all three readers.** Our `type` is correct for
ERC-4824 and must stay. The fix is to never serve one document to two audiences:
if a Buzz org also wants to be an ERC-8004 agent, that is a *second* document at
a *second* URI. Record the decision in the NIP so nobody tries to merge them.

### 4.2 Canonicalization is a hard requirement, and we have a partial answer

ERC-8257 commits `keccak256` over **JCS (RFC 8785)** bytes, and because JCS does
not normalize Unicode, BOM, or hex case, it adds three rules and requires
consumers to **reject rather than silently fix**:

> no silent re-normalization, since that would change the bytes that were hashed ·
> consumers MUST reject a fetched response whose bytes begin with `EF BB BF` ·
> consumers MUST reject manifests containing uppercase hex digits in any of the
> listed fields rather than silently lowercasing them

Our `document_bytes` relies on `serde_json`'s sorted maps. That gives
**determinism**, which the golden vectors test. It is **not** JCS byte-identity,
and it is not NFC-normalized. Today nobody can verify our bytes against a
commitment, so this is latent rather than broken — but if we ever want a
`manifestHash` or a `daoURI` commitment, this is the work. Two concrete gaps:
`orgURI`-style URLs and CAIP-10 ids must be lowercase hex, and we should assert
NFC in the golden vectors.

### 4.3 `x-ao.enforced` → the consequential-events register

Current: a flat list of backed clause ids (`right:mayPropose`, …). Better, and
what ACAP Section C actually specifies, is per-event:

```
{ action, whyConsequential, reversible: bool,
  checkpoint: {kind: "human-approval" | "policy-as-code", approver},
  escalation: [...], onViolation }
```

with authority categorized **permitted / conditional / prohibited.** This is
the structural answer to auditability-washing: a community claiming a right it
cannot enforce is *visible*, because the register says which events have a real
checkpoint and which are self-asserted.

### 4.4 Extension naming: we are contested

ERC-8257 follows RFC 6648: reverse-DNS preferred (`io.opensea.paymentHint`),
and `x-` keys "remain tolerated for backwards-compatibility with ecosystems
that adopted them, but new extensions SHOULD prefer reverse-DNS."
**DAOIP-5 recommends the opposite** — `x-` for experimental.

Since our extensions live in **DAOIP-5's** `extensions` field, `x-` is currently
correct and I would not churn it. But record the divergence, and reserve
reverse-DNS (`org.buzz.ao.*`) for anything we expect to outlive the DAOIP-5
container.

### 4.5 Name the HITL/HOTL distinction we already ship

The WEF Foundations paper:

> **human-in-the-loop (HITL)** — agents can suggest or prepare actions, but final
> decisions remain subject to explicit human approval.
> **human-on-the-loop (HOTL)** — agents act within defined boundaries, while humans
> monitor behaviour, receive alerts and retain the ability to intervene or override.

That is `46010` approval cards (HITL) and `37012` budget execution (HOTL).
Nobody had named it. Name it in NIP-ORG so the panels stop inventing vocabulary.

### 4.6 The supervision paradox is a rate limit, not more cards

> frequent checkpoints may risk becoming **routine approvals rather than
> meaningful oversight** if the volume of actions exceeds capacity for careful
> review … Mitigation should include rotating approvers, attention management
> protocols, **defined escalation time limits aligned with agent execution
> speed**, and regular calibration exercises using cases with known ground truth.

This is aimed squarely at the 24-hour *"your agent will vote yes — dismiss
this"* notification from #7. **Our `46010` cards have a named failure mode and
no rate limit.** Add one: a per-seat approval budget, and an explicit
"supervision saturation" state when the budget is exhausted.

### 4.7 Add self-review prohibition to `37013`

ERC-8004: *"The feedback submitter MUST NOT be the agent owner or an approved
operator for `agentId`."* Our contribution records have no such rule — a
founder can currently grade their own agent. One line, and it makes
`37013` a real signal rather than a self-report.

### 4.8 The Wyoming DUNA default is wrong for commercial orgs

`contracts/lib/majeur/src/Renderer.sol:153-170` renders a **Wyoming
Decentralized Unincorporated Nonprofit Association** operating charter
(W.S. 17-32-101) into the very `contractURI()` that a `daoURI` would point at,
and `summonAndBind` pins `renderer = address(0)` so every bound org inherits it.

**A commercial AO — a cafe, a merch store, a trading desk — would render a
nonprofit charter onto its own metadata card.** That is a category error and it
is a live default, not a future concern. Either parameterize the charter per
org, or make the adapter required so a bound DAO cannot present the DUNA
default as its own.

This is also the sharpest instance of Leibo's jurisdictional point: **Wyoming
answers it one way, MetaLeX answers with Delaware, and nothing tells a Buzz
community outside the US what it just opted into.** `x-ao.personhoodClass`
cannot be a bare string — it needs jurisdiction, and `contracts[]` must name
*which* legal wrapper, not just that there is one.

**Decision (2026-09-27): no default wrapper ships.** `none` is the default and
a legal value; a community opts into a DAO LLC, ties its own existing entity,
or starts with nothing and decides before token launch. The adapter stays
**required** — a bound DAO must never present the renderer's DUNA default as
its own.

### 4.9 Adopt the WEF's adversarial early-warning list

> unusual data or credentials accumulation, **attempts to influence what human
> supervisors see**, persistence across resets or strategic underperformance
> during evaluation. These are early warning signs, not edge cases.

Three transcripts in one sentence: Axel's trust injection (rapport, then a
"brilliant workaround to bypass our strict firewalls"); DeepSeek's bad basin in
AI Village; and eval-gaming. We already have `KIND_SCORE_ROOT` (37006) to hang
it on. This is Phase 4's detection surface.

### 4.10 Steal one thing from ANS: version binding

ANS-2 asks a question we **cannot currently answer**: *which version of this
agent am I talking to?* NIP-OA proves an agent key is authorized by an owner
key. It says nothing about **which persona, which version, which code** sits
behind that key — so when `buzz-persona` updates a configuration, the agent's
*identity* is unchanged and its *behavior* may not be, with nothing recording
the transition.

That is precisely the baseline §4.9's drift detection needs. Smallest item on
this list with the clearest payoff: a replaceable event carrying
`{personaVersion, personaHash, observedAt}` bound to the agent key and chained
into `buzz-audit`.

**What must not cross from ANS: PKI.** ANS's trust anchor is a Certificate
Authority and its Registration Authority "validates the **legal entity** of
the Requesting Agent." Nostr has no CA and the design goal is that there is no
registration authority. That is a principled incompatibility, not a gap.

---

## 5. One classification, reconciled

Three sources propose a classification. They are not rivals — they nest.

| Source | Dimensions |
|---|---|
| WEF Foundations | Function · Role (specialist↔generalist) · Predictability (det↔non-det) · Autonomy (SAE L0–5) · Authority (read-only↔admin) · Use case · Environment (simple↔complex) |
| ANS Trust Index | Integrity · Identity · **Solvency** · Behavior · Safety |
| Trivedi (#6) | Dynamic testbeds · Institutions as the primitive · Human learning in the presence of deployed systems |

**Proposal:** adopt the WEF's seven as the classification axes (they are the
only ones with defined poles and stated consequences), and fold the ANS Trust
Index in as the *evidence* dimension. We can already populate **identity**
(NIP-OA), **solvency** (`OrgAllowance.remainingOf`, major's shares) and
**integrity** (`buzz-audit`); **behavior** and **safety** are the gaps. Note
that solvency is Leibo's *skin in the game* as a scored dimension, arrived at
by a domain registrar's trust team — and it is measurable today.

One WEF definition does real work:

> **Simple** environment: complete information, predictable and static
> outcomes, independent episodes, a finite set of states, and **no need to
> consider other actors.**
> **Complex** environment: uncertainty, changing conditions, and **interactions
> with other agents whose behaviour also affects results.**

That is a formal definition of *multi-agent* as a property of the **world**,
not the system — and it yields a checkable claim: **a Buzz `37010` node is
always `environment: complex`,** because other actors are in the environment by
construction. That is the cleanest external justification `VISION_ORG.md` could
get.

Trivedi's triad is the right *Phase 4 research agenda*, not the right
per-org field. Keep it there.

---

## 6. What remains

### Phase 3 — attach to Majeur

Majeur already ships the slot. `contracts/lib/majeur/src/Moloch.sol` has
`contractURI()` (~line 1018) reading the `_orgURI` string (line 155) with a
renderer fallback, and `setMetadata(name, symbol, uri)` (line 851) is
`onlyDAO`. ERC-4824 asks for "a standard `daoURI`, **similar to `tokenURI` in
ERC-721**" — majeur shipped the tokenURI-shaped thing under another name.
**The integration is a rename, an event, and a route.** No new storage.

Note that `contracts/lib/majeur/dapp/Majeur.html:25434` already builds a local
variable named `daoURI` (via `buildContractURI()`, line 9030) containing
ERC-721-shaped metadata — so the ecosystem reached for the name and put the
wrong shape there. Phase 3 is a **shape upgrade of a half-built field.**

- `DaoURIAdapter` exposing `daoURI()` + `DAOURIUpdate` over `contractURI()`.
  Not optional: with `renderer = address(0)` and an empty `_orgURI`,
  `contractURI()` returns `""`, so the onchain entry point is a blank string.
- `OrgBinding.summonAndBind` accepts the URI; `DaoBound` per ERC-4824's
  `DAOURIRegistered`.
- Verify the `x-ao.bundle` enforceable subset against live DAO config, the way
  S1 already verifies quorum.
- Fix §4.8 in the same change.

**Acceptance:** a bound org's `daoURI` dereferences to a document whose
`contracts[]` names the summoning DAO; re-summoning updates both sides under the
same LWW rule. ERC-4824's *"most recent registration takes precedence"* is
exactly NIP-33 LWW on the `37010` head — the two standards already agree about
ordering.

### Phase 4 — the differentiated instrument

Built last, because legibility is the precondition. **Status (2026-09-28):
the instrument core ships** as `buzz-core::org_diag` (pure, deterministic,
integer-exact basis-point statistics — goldens in-crate) with `buzz diag` as
the CLI host (open-decision 5: a CLI twin of a workflow action; the
relay-side scheduled host follows). What is instrumented, named to source:
Pentland's time signal (timing-only burstiness + cross-actor handoffs — safe
even when identities are synonymous), Tomasello's three layers with
institutionalization weighted (the CooperBench lesson), the five WEF failure
modes as the taxonomy with the §4.9 early-warning signals behind them,
Cursor's thrash-vs-work scoreboard (rework vs settled coordinates),
per-actor drift probes (the AI Village shape: a moved distribution; "bad" is
never inferred), and supervision saturation including the governor-agents
concentration risk. Open-decision 5 is resolved: the instrument hosts are
the `buzz diag` CLI and the scheduled **`run_org_diag` workflow action**
(deterministic, no LLM — the report is the step output, so run history
carries the instrument's own trend line and drift across runs is observable;
no new wire vocabulary). Licensed intentional breakage (Cursor) remains a
mechanism, not an instrument — deferred as a design discussion.

- **Time-signal correlation detection** over the audit chain. Pentland's specific
  claim: coordination is detectable from timing *"even if all the identities are
  synonymous."* Buzz is the substrate that can do this.
- **Tomasello's three layers** as an org diagnostic: communicate / build trust /
  institutionalize. CooperBench showed agents talk constantly and it changes
  nothing (the comms ablation was null), so volume is the wrong instrument.
- **Dotta's three eval tiers**, with tier three — *"how do you make sure that
  they interact with one another in a way that you expect?"* — the one we have no
  incumbent at.
- **The five WEF multi-agent failure modes** as the taxonomy: orchestration drift,
  semantic misalignment, security/trust gaps, cascading effects, systemic
  complexity. The first two are Cursor's split-brain and 70,000-conflict run,
  named in governance language.
- **Cursor's thrash-vs-work metrics** as the scoreboard. Their old harness:
  68,000 commits in 2h, **70,000+ merge conflicts**, hottest file **7,771
  conflicts from 1,173 agents**, **54 crates including three duplicate SQL
  packages**. New: **<1,000 conflicts over 4h**, hottest file **47**, **nine
  crates settled early and never changed**, and 4,645 lines of engine code at
  100% versus 19,013 at 97%. Their read: *"One reading is that it was more
  productive. Another is that most of those commits were busywork."*
- **"Governor agents"** — the WEF names the layer and its own risk: dedicated
  auditor agents "enable scalable oversight in complex ecosystems, but they
  **risk overreliance on agents supervising other agents**."

One thing to steal from Cursor that nothing else has: **licensed intentional
breakage.** Agents learn from human codebases not to touch core code even when
it needs changing; their fix is to let an agent make a focused patch outside its
scope, leave a comment, and let the compiler carry the breakage through so every
dependent updates. No NIP, ERC, or ANS has this. It is a governance primitive
for software change.

---

## 7. Risks

**This is a legibility move, not a cooperation move.** Trivedi: *"the more the
system becomes powerful, the more self-undermining they become"* and
*"cooperation itself is not a task to solve."* A beautiful document does not make
Buzz communities cooperate better. It makes them **inspectable.**

**`governance.md` is auditability-washing waiting to happen.** The most likely
failure is social. Two structural guards exist — the three-fact litmus test from
[`docs/agentic-governance-design.md`](docs/agentic-governance-design.md) §0, and
§4.3's register.

**A charter read by a model is a load-bearing dependency.** Cursor's footnote:
GPT-5.6 Sol *"appears more sensitive to literal and emphasized wording than the
other models we tested, and we encountered runaway spirals unlike anything the
other models produced."* If anything depends on *interpreting* the charter prose,
that dependency is real. Prefer machine-readable fields; treat the prose as
audience, not as control.

**Both adopted standards are unstable.** ERC-4824 is in peer review; DAOIP-5 is
an unaccepted branch. This is an independent reason the projection is a pure
function and the speculative parts live in `extensions`.

**An unbound document is a claim, not a fact.** Unbound communities will be
tempted to read their own thin document as a legitimacy signal.
[`docs/aos/ao-survey.md`](docs/aos/ao-survey.md) says so in as many words.

**No EIP covers what we are best at.** That is an opportunity and a risk: the
white space may be closed by someone else, or may turn out to be a market
regulator's job.

---

## 8. Open decisions

| # | Question | Deferred to |
|---|---|---|
| 1 | Does the served route stay a pure projection, or does a signed event point at it? The spoofing tradeoff favors recompute (§3 of [OA.md](OA.md)) | Phase 3 |
| 2 | `x-ao.personhoodClass` — free string or closed vocabulary, and what jurisdiction scheme? (§4.8) | Phase 3 |
| 3 | `x-ao.enforced` — flat clause list, or the full consequential-events register? (§4.3) | Phase 3 |
| 4 | Do we serve a second ERC-8004-shaped document for Buzz-as-agent, or decline? (§4.1) | Phase 3 |
| 5 | Is version binding one NIP or an extension to NIP-OA? (§4.10) | Phase 4 |
| 6 | Supervision saturation: what is the per-seat approval rate limit? (§4.6) | Phase 4 |
| 7 | Charter provenance: wiki page, or a signed NIP-ORG record rendered to markdown? | Phase 3 |

---

## See also

- [OA.md](OA.md) — v1; the original integration plan and the trust-boundary argument
- [docs/aos/ao-survey.md](docs/aos/ao-survey.md) — Phase 0; the field's definition, trust boundary, enforcement table
- [docs/nips/NIP-ORG.md](docs/nips/NIP-ORG.md) — `37010`–`37015`: nodes, grants, budgets, contributions, pitches
- [docs/nips/NIP-LP.md](docs/nips/NIP-LP.md) — launches, proposals (now with `calls[]`), receipts
- [docs/agentic-governance-design.md](docs/agentic-governance-design.md) — the three-fact litmus test
- [docs/dao-launchpad-plan.md](docs/dao-launchpad-plan.md) — CCA mechanics, futarchy scoping
- [VISION_ORG.md](VISION_ORG.md) — the community-owned org; seats; private → shared → onchain
- [VISION_SOVEREIGN.md](VISION_SOVEREIGN.md) — the domain *is* the workspace (ANS's anchor, independently)
- [crates/buzz-core/src/erc4824.rs](crates/buzz-core/src/erc4824.rs) · [crates/buzz-relay/src/api/dao_json.rs](crates/buzz-relay/src/api/dao_json.rs)
- [contracts/src/OrgBinding.sol](contracts/src/OrgBinding.sol) · [contracts/src/OrgAllowance.sol](contracts/src/OrgAllowance.sol) · [contracts/lib/majeur](contracts/lib/majeur)
