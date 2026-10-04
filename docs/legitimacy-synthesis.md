# Legitimacy, conviction and contribution: what we took, what we missed

`draft` `design` `research`

Written 2026-10-04 against `claude/org-graph-social`. This reads four bodies of
work against what is built, and lists the gaps that are real. It adds no new
vision; [dao-os.md](dao-os.md), [agentic-governance-design.md](agentic-governance-design.md),
[token-lifecycle-design.md](token-lifecycle-design.md), [OAv2.md](../OAv2.md) and
[next-gen-launchpad-plan.md](next-gen-launchpad-plan.md) remain the contract.

## 0. What I could and could not read

| Source | Read how | Caveat |
| --- | --- | --- |
| "Farewell to DAOs" (McCarthy et al.) | Pasted in full by the user | First-hand |
| ResonantOS economy research (`ResonantOS/resonantos-economy-research`) | Cloned; the `official-whitepaper` subtower is only a scaffold that **summarises** the DAO whitepaper | Second-hand for the DAO whitepaper |
| resonantos.com (`#core` and the rest) | `resonantos.com` is blocked by the sandbox, but the site is a static page in `ResonantOS/resonantos-website`; I read its HTML source from GitHub | First-hand for the *technology* pitch. No browser or computer-use tool exists in this session, so I could not look at the rendered page |
| ResonantOS 2.0 planning docs (`ResonantOS/2.0.0-alpha`, `docs/planning/02-sdk-dao-governance-roadmap.md`) | Cloned and read | First-hand. This is the *developer-organization* governance design, not the economy |
| ResonantDAO whitepaper (credentials, `$RES`, marketplace, governance, Solana target) | **Not read.** `resonantdao.com` is blocked and the repos only hold the *legacy philosophical* whitepaper | The one source still missing for the economy |
| Conviction Markets paper (Outlier Ventures, Mar 2026) | Our own notes only ([dao-launchpad-plan §10](dao-launchpad-plan.md), [next-gen §4](next-gen-launchpad-plan.md)); the PDF is not in the repo | Second-hand. Confirmed by the user to be the same Outlier Ventures paper we already read |
| Stanford AO talks | Our line-cited survey ([aos/ao-survey.md](aos/ao-survey.md)) and [OAv2 §1.4](../OAv2.md) | The transcripts live on the user's Mac, not here |
| `apptoken-skills`, `majeur` | Cloned / vendored (`contracts/lib/majeur`) | First-hand |

Anything below that depends on the ResonantDAO whitepaper or the conviction
paper is only as good as those summaries. **Paste the ResonantDAO whitepaper
text, or allow `resonantdao.com`, and I will re-check sections 2 and 3 against
the source.**

## 1. What we already took

| Idea | Source | Where it lives |
| --- | --- | --- |
| Mechanism matched to the decision's information structure, never one ballot | Farewell; Hayek framing | [Decision routing](agentic-governance-design.md) (`signal` / `plain` / `futarchy-budget`); futarchy scoped to budgets only |
| Technical guarantees as the base of legitimacy | Farewell | Ragequit on every surface, CCA refunds, cancellable streams, `OrgAllowance` |
| Credible commitments by staking | Farewell; Conviction paper | `ClaimStake` + `VerifierSet` (slashable stake) |
| Attestations that make actors attributable | Farewell | Receipts (47005), `37011` grant chains, `37013` contribution records, self-review prohibition |
| Legible boundaries for outsiders | Farewell; AO summit | `/dao.json`, `governance.md`, ERC-4824 projection, `org_diag` |
| Agents as participants under attenuating authority | Farewell; AO summit | Org seats, budgets, NIP-OA provenance |
| Reputation separate from capital | ResonantOS | TrustGraph roots (37006); Majeur soulbound Badges for milestone tiers (D12) |
| Credit before money | ResonantOS | Royalties minted only at attested claims (D6) |
| Speculation as a derivative of productive capital | Conviction paper | CCA raise + streams + milestone unlocks vs TM floor + LBAMM premium |

So the structure was not missed. The gaps below are specific.

## 1b. What the ResonantOS technology adds

The `resonantos.com` page and the 2.0 planning docs are about a *runtime*, not an
economy, but four ideas transfer:

| ResonantOS idea | Ours today | Verdict |
| --- | --- | --- |
| Delegation that can only shrink; revoke kills the chain | `37011` attenuation, transitive revocation | Already there; G8 adds purpose and declared depth |
| **Consequence protocol**: irreversible actions persist intent, expose *unknown* outcomes, reconcile before retrying; no duplicate payments or publishes | Deploy flows detect steps that already landed and offer a targeted retry ("may or may not have been sent") | Done for the human deploy path; **not** for agent-initiated spends. This is the consequential-events register still pending in [OAv2 §4.3](../OAv2.md) |
| **Evidence spine**: observed facts kept apart from agent reasoning | Tiered reasoning (D9), receipts, audit chain | Already there |
| Sovereign worlds: private per principal, shared **only by agreement with roles and quorum**; "no path between privates" | Private channels, DMs, org seats | Partly. Our rooms are shared by admission, not by a recorded agreement; fine for chat, worth revisiting for shared agent workspaces |
| "We crash it on purpose" as the acceptance test | Declined-transaction and retry tests; the journey spec | A good bar for the next hardening round: kill the relay mid-deploy and mid-admit and assert nothing duplicates |

Their separation of powers (author, reviewer, marketplace, DAO, user, runtime
authority) and the rule that "NFT level is eligibility, not unilateral power"
match our decision routing and soulbound tiers. Their decision table, in which
certification and constitutional change never share one token vote, is the same
move as [decision routing](agentic-governance-design.md).

## 2. Tensions to decide, not bugs

These are places where a source says "do not" and the product deliberately does.
Per [AGENTS.md](../AGENTS.md), intentional tension should be explicit.

1. **Credited is owned vs "no automatic value from a contribution record".** The
   ResonantOS research blocks automatic accumulation and conversion, person
   totals, history as entitlement, and reviewer-chosen-by-claimant. Our D2 makes
   attested revenue irrevocable and our tiers are cumulative. What keeps us on
   the right side today: entitlements come only from a *quorum-attested* claim
   (D6), are bounded in share and term, and there is no floating reputation
   formula. What does **not** yet hold: see gaps G1 and G2.
2. **Reputation gating capital.** The curated track gates bids on a TrustGraph
   score. That is score-to-*access*, not score-to-governance, but ResonantOS
   treats score-to-authority as the failure to avoid. Keep it, and pin the line
   with an invariant (G6): no score ever feeds Majeur voting power.
3. **Agents and governance.** ResonantOS: agents may earn and spend, but get no
   human-only governance rights. Ours: agents may be delegates (D3), with
   "mandate vs advisory" still open (D10). Resolution below (G5).

## 3. Real gaps, ranked

### G1. Reviewers are not conflict-aware (contracts, small, high value)

`VerifierSet.attest` binds only `claimId`. It does not know the claimant, so a
verifier who is also the claim's contributor can approve their own claim, and
`ClaimStake.settle` counts that approval. The treasury owner (the founder, until
graduation) also chooses the verifiers. This is the "claimant-selected
reviewer" failure.

ResonantOS's DAO roadmap names the same threats ("self-certification: author
cannot satisfy all approvals for own release"; "reviewer collusion: multi-review
thresholds, conflicts policy, public attestations") and leaves the conflicts
policy as an open decision, so this is somewhere we can lead.

Slice: `ClaimStake` registers the claimant with `VerifierSet` at submit;
`attest` reverts `SelfAttest` for the claimant. Forge tests: claimant cannot
attest, cannot be counted toward quorum, other verifiers unaffected.

### G2. A claim can stay open forever (contracts, small)

`ClaimStake` has `Open`, `Approved`, `Rejected` and a frozen path, but no
*held-with-expiry*. An unreviewed claim locks the contributor's stake with no
exit. Slice: a deadline set at submit; after it anyone can `expire`, returning
the stake **unslashed**, and the royalty is never minted. Expiry is not a
verdict, which is the point.

### G3. The supporter gate is a vanity metric (web, medium)

"10 supporters" counts follows, which are free and have no age. The conviction
paper's own definition is *duration, compounding, productive* (time x capital x
contribution), and our plan left that as an open, undelivered weight formula
("P6", next-gen §4). The idea stage now has the data to deliver it without a new
event kind:

- time: when someone joined the supporters room (a timestamped kind 9021);
- contribution: messages they wrote there, distinct days active;
- capital: a recorded bid, later.

Slice: `lib/conviction.ts`, a pure, deterministic, integer-exact weight with test
vectors (like `org_diag`), no person total shown to users and no reward effect.
It replaces the raw count in the gate and orders "waiting to join" backers. The
rule from ResonantOS stays: it informs a *nudge and a sort order*, never
authority or money.

### G4. Visibility feeds access feeds status feeds visibility (web, small)

The longitudinal attack in the ResonantOS tower is exactly our trust-ranked feed:
trusted accounts get seen, gain followers, gain trust. The size-aware blend
limits it but does not break the loop. Slice: reserve a fixed share of For You
slots for accounts and launches below a trust floor, chosen deterministically
per day, and add a test that fails if the share drops to zero.

### G5. Agent seats: say what an agent cannot hold (product + small contract guard) — **decided: mandate-bound**

Rule: an agent may earn royalty income and be a delegate under a revocable
grant; it never owns voting Shares in its own right. Enforce where we can: the
org-board approval grants **Loot** (economic only) to an attested agent
requester, never Shares; delegation to an agent carries the human principal's
weight and shows the grant chain. **D10 is resolved: agents are mandate-bound.** An agent votes only inside its
grant, with the human principal's weight, and its card shows the grant chain;
outside a grant it may advise but not vote. A human-required checkpoint can never
be satisfied by an agent. ResonantOS's DAO roadmap arrives at the same rule
("governance decisions require explicit human cryptographic acts; content is not
authority").

### G6. Pin the "reputation never becomes governance" line (test, tiny)

A test that searches the contract sources for any read of a score, badge tier or
TrustGraph root in a voting-power path, and fails on a hit. Cheap, and it turns a
principle into something a reviewer can break.

### G7. Founder commitments are mostly text (product, later)

Farewell lists credible commitments. Founders' *token* commitments are enforced
(milestone unlock plans). Their *cadence* and *story* are not: the readiness
check asks for a long pitch and a cadence, but nothing binds them. A cheap,
honest version: show "updates promised monthly, last update N days ago" on the
launch page, computed from the record, so a missed cadence is visible rather
than enforced. A bonded version needs an objective oracle and is parked.

### G8. A grant has no stated purpose or depth limit (spec, small)

ResonantOS's "delegation that can only shrink" is scope, expiry, **purpose** and
a **depth limit**, and revoking a grant kills the whole chain at the next check.
`37011` already has attenuation, expiry, transitive revocation and a bounded
chain walk. What it lacks is a grantor-declared `purpose` (why this authority was
handed over, shown on the authority card) and a grantor-declared `maxDepth` (the
walk is bounded by the system, not by the person delegating). Both are additive
fields.

### G9. Decisions are not first-class objects (UI / wiki, small)

The ResonantOS hub makes a *decision record* a first-class object: context, the
decision, **alternatives considered and why rejected**, participants, references.
Ours emit receipts (who, which mechanism, tx) but not the reasoning that a
newcomer needs a year later. A processed proposal should publish one decision
page (a wiki page, kind 44001) generated from the proposal, the thread and the
receipts, with an "alternatives considered" section the proposer fills in. It
serves the litmus test directly: *which mechanism decided this, and why.*

### G10. Emergency action has no mandatory post-action review (product, medium)

ResonantOS: emergency removal is an "authorized rapid suspension + audit +
**mandatory post-action review**". We have no moderation or suspension surface at
all (the audit's gap 5). When we build one, the shape is fixed: an operator may
suspend a listing at once, but the suspension is a public receipt that opens a
review which must be closed by someone else, or it lapses.

## 4. Putting it together with majeur and apptoken

| Need | Use | Not |
| --- | --- | --- |
| Governance, exit, dissent | Majeur Shares, ragequit, split delegation | A custom voting token |
| Passive / agent economic stake | Majeur **Loot** (no vote) | Shares |
| Join by contribution | Majeur Tribute (already routed) | Airdrop by follower count |
| Milestone tiers | Soulbound Badges (D12) | A fungible reputation token |
| Project token, floor, liquidity | Apptoken TokenMaster + LBAMM; LBAMM position hooks for LP time locks | Bespoke AMM code |
| Non-transferable *per-claim* record | `37013` + attestation, no person total | An `RCT`-style balance. Apptoken's Soulbound ruleset would make one trivial, which is the reason **not** to: it is a person total |
| Community allocation | Distribute by conviction weight (G3) via a merkle root, like the TrustGraph score roots | Equal airdrop, or by follows |

The last row is the larger follow-on: the supply split already has a `community`
share; G3's weight is the principled way to distribute it.

## 5. Order I would build

1. **G1 + G2**: one contract change, tested with Forge, which now runs here.
2. **G3**: the conviction weight, then swap it in for the supporter count.
3. **G4 + G6**: small, and they pin the two loops the research warns about.
4. **G5**: D10 is decided (mandate-bound), so this is unblocked.
5. **G8, G9**: small additive spec and wiki work.
6. G7, G10 and the community-allocation distributor: after real usage.

## 6. Decisions

Decided (2026-10-04, by the user):

- The conviction paper is the Outlier Ventures PDF we already read.
- **D10: agents are mandate-bound.**

Still open:

- May G3's weight only order and nudge (recommended), or also drive the community allocation?
- Is the ResonantDAO whitepaper reachable (paste, or allow `resonantdao.com`)? Until then, sections 2 and 3 rest on the ResonantOS research summary.
