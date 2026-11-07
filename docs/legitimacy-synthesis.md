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
| `whitepaper.astro` (the page the user pointed to) | Read. It calls itself the **legacy philosophical** whitepaper and points to `resonantdao.com/whitepaper` for the DAO design | First-hand, philosophy only |
| The earlier "Resonant Economy" page (`dao.astro`, in the website repo's **git history**, before 2026-05-05) | Recovered from history and read | First-hand, but an **earlier design**: it uses `$R10/$R12/$R15`, which the research repo says the current whitepaper does not carry as live policy |
| ResonantDAO whitepaper, **current** (credentials, `$RES`, 22-dimension contribution, governance, roadmap) | **Pasted in full by the user (2026-10-04)**; section 1d | First-hand. It is a working draft and lists its own open questions |
| Conviction Markets paper (Outlier Ventures, Mar 2026) | Our own notes only ([dao-launchpad-plan §10](dao-launchpad-plan.md), [next-gen §4](next-gen-launchpad-plan.md)); the PDF is not in the repo | Second-hand. Confirmed by the user to be the same Outlier Ventures paper we already read |
| Stanford AO talks | Our line-cited survey ([aos/ao-survey.md](aos/ao-survey.md)) and [OAv2 §1.4](../OAv2.md), plus **all eight transcripts the user uploaded on 2026-10-04** (summits 2 to 9; sections 1f and 1g) | First-hand. Auto-captions with heavy ASR noise; speaker attribution is provisional. Summits 4 and 5 were read in full; summit 6 was read through the Hao Zhu, Pasupalak and Wang talks, and its last third (the closing discussion) was only skimmed |
| `apptoken-skills`, `majeur` | Cloned / vendored (`contracts/lib/majeur`) | First-hand |

The conviction paper is only as good as our earlier notes. The ResonantDAO
whitepaper is now read first-hand (section 1d), and it **corrects two things I
wrote earlier**: the "earlier page" in section 1e is superseded, and my first
version of G3 broke the whitepaper's own rule that contribution pays on outcome,
never on activity.

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

## 1c. The other ResonantOS repositories, triaged

All eight public repos under `github.com/ResonantOS` were checked (cloned over
git; the web pages themselves are blocked).

| Repo | Useful? | What for |
| --- | --- | --- |
| `resonantos-economy-research` | **Yes, most** | `failed-dao-crypto` findings (T1-T9): per-identity scoring is farmable (T4), anti-sybil defenses get bribed or over-exclude (T5), vote != execute (T8), reflexive native-token treasuries (T2/T3). `monetary-circulation`: report runway and exit capacity separately (G12). `contribution-mechanism`: the "what to block" list used throughout this doc |
| `2.0.0-alpha` | **Yes, in part** | The SDK + DAO governance roadmap (decision table, threat table, separation of powers). ADR-023/024 (addon registry and store commerce) are worth reading before we build project templates or a marketplace; ADR-028 is a Paperclip organizational runtime, which we already bridge |
| `resonant-hub` | A little | Tribes and bounties design, the decision-record schema (G9), and a red-team report of its own admin console (wallet-ownership proof, JWT revocation) that mostly describes problems NIP-42 signed events already avoid |
| `akashic-records` | Maybe | A git-authored library of Source and Claim cards with exact evidence links, independent review records, and "retrieval is not truth or approval". Relevant to making `37013` evidence legible (today an `evidenceHash`) and to the agent wiki. A candidate to study, not to adopt |
| `resonantos-website`, `augmentatism.com` | Context only | The technology pitch (section 1b) and the philosophy |
| `ResonantOS-Team-Coordination-Hub` | No | A Reddit-and-spreadsheet process: post types for task, decision, blocker, weekly update |
| `rcode` | No | A coding-harness fork. We have our own agent harness, and its README describes its origin in terms I would not build on |

## 1d. The current ResonantDAO whitepaper

A membership DAO, not a launchpad. Phase 1 (now, testnet or devnet, Solana
mainnet targeted Q4 2026) is a contribution economy: non-transferable credentials,
a transferable reward token `$RES`, a marketplace, a weekly call, an academy.
Phase 2 (a financial layer, "after 2028, readiness first, timeline second") is
explicitly gated and researched, with its own risk discipline.

| Whitepaper position | Verdict for Creaton |
| --- | --- |
| **Contribution pays on outcome, never on activity.** Attendance, message volume and time spent are never rewarded as such | **Adopt as a hard rule.** It overturns my first G3, which counted messages and active days. See G3 |
| **22-dimension profile, never one number.** Verified actions update 22 non-transferable balances. `$RCT` is a derived scalar, "an approximate indicator" that "never replaces the detailed profile"; governance weight comes from the profile, not the scalar | The *principle* (report a profile, not a total) is already ours (no person total). The 22 dimensions are their own taxonomy and their on-chain form is an open question in their own list; do not copy it |
| **Contextual governance**: each question declares its salient dimensions, and weight follows verified balances in exactly those | Same instinct as our decision routing. Theirs weights by *who has relevant verified outcomes*; ours routes by *what kind of decision it is*. The weighting half is **untested and rests on per-identity scores**, so park it (G3, T4) |
| **Committed capital is recognized at low weight and never counts toward voting**; general control can never be bought | **A real fork.** Our project token carries governance, so capital does vote (tempered by ragequit and Loot). See tension 4 |
| **AI members must be sponsored by, and linked to, an active human member**; the human is accountable, and the DAO can restrict or ban the AI accounts. Agent-performed work earns measurement and `$RES`, but **only the human-attributed portion can ever count toward voting** | **Matches the decided mandate-bound rule** and sharpens it (G5): sponsor link, human-attributed portion, no capital-as-AI route to power |
| Non-transferable credentials, one active credential per wallet, wallet signs the Manifesto text hash as **proof of agreement** | We have soulbound Badges but no explicit *agreement to the charter*. See G15 |
| **Tiered verification**: automatic checks for deterministic events, independent human review for ambiguous, relational or high-impact work | We use one mechanism (a verifier quorum) for every claim. See G16 |
| **Custodian-led bootstrap**, stated honestly ("not fully decentralized on day one") | Ours is the founder as treasury owner of `VerifierSet` until graduation. Honest in the same way, but the *transition rule* must be explicit (G1) |
| Human trust is a **continuously maintained state**, not a one-time KYC (history, attestation, proof-of-life, anomaly review) | Our trust signals are TrustGraph roots and follows. Nothing here is "maintained" or decays; worth a later look |
| `$RES`: 1,000,000,000 minted to the DAO treasury, **no external liquidity at launch**, internal reward and utility first | Same caution as our CCA design (nothing tradable before graduation, reserve escrowed). Not a gap |
| Phase 2: `$R10` growth target, `$R12`/`$R15` locked yield, buyback and burn, "Universal Contribution Income" | Still **do not import** (section 1e). Notably the whitepaper itself says "algorithmic token systems have failed before" and defers this |
| Its own **open questions**: reward emission limits, on-chain form of the 22 balances, validation rules, **anti-farming and anti-capture rules**, governance thresholds | The sybil problem is *unsolved in the source*. That is the reason our reward-bearing weights must be cost-bound (G3) |

## 1e. The earlier Resonant Economy page (recovered from git history; superseded)

Phase 1 is a contribution economy: `$RCT` as a non-exchangeable "karma" token,
per-community `$P*CT` tokens, and a *Contribution Level* from four categories
weighted 1.5x connection and support, 1.2x exploration, 1.0x creation, 0.8x
financial. Phase 2 is a financial layer: `$R10`, an algorithmically managed token
targeting +10% APY, plus `$R12`/`$R15` locked-yield tokens, a daily leaderboard
paying the top 80%, a 20% lottery tithe funding a "Universal Contribution
Income", and a treasury that buys Bitcoin and buys back `$R10`. Governance is
"contribution over capital": voting power from the contribution score, not from
tokens. Our verdicts:

| Their idea | Verdict for Creaton |
| --- | --- |
| Culture first, finance second; recognition before money | **Adopted** (the idea-first flow; credit before money). |
| **Honest AI framework**: humans capped per day at the full rate, agents uncapped at a lower rate, exceeding the cap reclassifies you, so declaring your agents pays | Not needed as an incentive: agents are attested seats with their own grants and mandates, so declaration is structural. The *rate card* idea (agents earn at a different, lower rate than humans for the same claim) is worth noting for the royalty schedule, not building now |
| **Escrow**: significant rewards held (e.g. 30 days) for community review before payout | **A real gap in our contracts.** See G13 |
| Leaderboard decay (10% a year) | We already bound entitlement by term (D6), which is stronger than decay |
| Daily leaderboard, bottom 20% earn nothing, a Universal Contribution Income | **Do not import.** Person totals and universal rankings are exactly what the contribution-mechanism research blocks, and per-identity payouts are the sybil target (T4) |
| `$R10` algorithmic +10% APY, algorithmic minting, treasury buybacks | **Do not import.** This is the reflexive native-token shape the Terra postmortem (T2/T3) warns about. Our treasury holds the raise in ETH or USDC, not in its own token |
| Governance by contribution score | **Contested.** The research repo itself flags score-to-authority as a failure to avoid. Ours: capital-weighted votes with ragequit, contribution entry by Tribute, and tiers that only set sell-rate bands (G6 pins the line) |

### G13. Approval can be withdrawn before anyone can challenge it (contracts, small)

`ClaimStake.payout` is callable by the contributor as soon as a claim is
`Approved`, in the same block as `settle` if they like. `freeze`, the only
challenge, is treasury-only and meaningless after a payout (a paid claim cannot
be frozen). So a quorum approved by a captured verifier set pays out before any
review can happen. Their "escrow, then review" is the fix: a **challenge window**
between approval and payout, in which the treasury (and, after graduation, the
DAO) can `freeze`. The window's length is a launch parameter, with a floor.
Slice it with G1 and G2, since all three change the claim state machine.

## 1f. The Stanford AO transcripts, re-read first-hand

Most of what these five talks say is already in the survey and OAv2 section 1.4
(the time signal, P&L as a reward function, the social license, trust injection by
name). A second pass found five things we had not carried into the product. Line
references are to the transcript's own timestamps.

| Talk | What it says | What we do with it |
| --- | --- | --- |
| #7 Pentland (20:48-22:16, 31:15-32:26) | MCP says *how* to call a tool but not *why* or under what limits. His "human context protocol" adds the **intent**, the **constraints**, and an **audit trail that comes back**, and the trail is what builds a reputation ("these are the good guys, those are flaky"). In Q&A he concedes a malicious agent will try to inject the safety layer, and answers only that the trail lets you spot it afterwards | **G8, extended**: a grant already carries constraints; add the intent, and make the receipt the audit trail that returns. Reputation from the trail must stay outcome-based and per-claim (G3), not a person score |
| #2 Wennström (06:22-06:50) | Prompt injection is not the live risk; **trust injection** is. People build a relationship with an agent over weeks and then talk it into acting, and two people did this to a live agent | **G17 (new)**: a conversation can never widen a mandate. Only a signed grant from the principal can |
| #2 Wennström (09:20-09:44) | A human followed a script "even though she didn't agree with what the script said", because it had acquired authority just by existing | Our checklists and the quick sale defaults are advice. Say so in the copy, and let a founder change any default without a warning. Decision records (G9) should note which values were defaults |
| #2 Wennström (13:23-13:38) | You can **replay a decision** with a different model and see whether it would make the same mistake | **G9, extended**: a decision record keeps its inputs (the proposal `calls[]`, the discussion thread id, the grant chain) so a reviewer or a second agent can replay it |
| #3 Rong (24:31-25:15, 23:40-24:00) | "Agents need names": a **model class** ("GPT-5") is a last name, stateless and fungible; a **named agent with a history** is a first name, and trust attaches to it. In practice there is one human operator per six to ten agents, and her network counts over 45,000 agents | Our agent identity is a keypair plus a grant, which is already a first name. Check that every agent card shows the persistent name and key, never the model. The 1:6-10 ratio is a useful default for supervision saturation (G5) |
| #8 Obadia (18:57, 17:10-17:40) | He expects **cartelization and bribery** between competing agents, and keeps a "customs" gate that decides what enters and leaves the arena, run by the organisers for now | We already have the instrument (`org_diag`, time signal). The new point is that it should be able to *flag* a pair of seats that always settle together, not only report averages |
| #9 plenary (18:07-18:55, 19:33-21:27) | Organisations used to need an explicit **charter saying why they should exist**; now anyone can start one. And a push for **co-op AOs**: a few people pool to *distribute* value rather than let one owner capture it | **G15, extended**: the charter states the purpose, not only the rules. **Tension 4 gets a third mode**: a "co-op" launch where the founders are also the first members with equal Shares and no outside float. See the note after G18 |

Not carried over: compute pooling, the narrative and survey-paper asks, and the
Foresight node discussion. They are real asks of the field, but nothing in a
launchpad changes because of them.

## 1g. The last three transcripts (summits 4, 5, 6)

These three are the ones the survey leans on most, so the question was what the
survey left out. Five things.

| Talk | What it says | What we do with it |
| --- | --- | --- |
| #4 Dotta (09:24-10:49) | "Any time you give your agent a key it will do everything it can to circumvent it." Sandboxing loses everything that made the agent useful, so the working pattern is a **permissions-aware proxy**: the agent never holds the key, the proxy does, and the policy is per action ("read my email as much as you want, but sending needs my approval"). Different agents get different access | **G17, extended**: enforcement must sit outside the agent's reach, and a grant should be able to tier actions (free, needs a human, never). Today a grant is a scope; the tier is the missing field |
| #4 Dotta (14:02-14:18, 17:27-17:50) | Exception handling is unspecified: "who do you escalate to?" is implicit in a human org chart and absent for agents. And you must define "good enough" up front, like a franchise's manuals of exactly how long to fry the fries | **G10 and G16, extended**: every agent seat names who it escalates to, and every claim declares its acceptance check before work starts, not after |
| #5 Leibo (15:15-16:30, 17:30-18:45) | Personhood is a bundle of rights and responsibilities. The design problem is **sanctions**: skin in the game (an account the agent can only operate while funded), and a registration credential on the network whose removal is "the ultimate sanction". Cutting off is retrospective, so you need graduated sanctions | **G19 (new)**: graduated sanctions. We have one tool, revoke. We need a ladder |
| #5 plenary (22:30-23:03, 31:20-31:32) | The hard case is "something went wrong and we can't find a human it's attached to". Someone has to be the person you can hold to account | **G5, extended**: an agent whose sponsor disappears is an orphan. Make its grants lapse when the sponsor's own authority does |
| #6 Hao Zhu (21:41-23:25, 23:30-24:10) | Agents talk 10-20% of the time but communication has no effect on cooperation (the muted ablation is null). The failures are a **commitment problem** (it promised a bypass check and never wrote it) and an **expectation problem** (it acknowledged the other's plan, then built its own duplicate) | **G20 (new)**: a promise in chat is not a commitment. Turn "I'll do this" into a claim with an expiry (G2) that other seats can see, so nobody builds the duplicate |

Already in the survey and unchanged: the three eval tiers (#4), the sandwich
(#4, "declare intent, agents execute, someone verifies"), the null communication
ablation and the 30-50% solo-versus-team gap (#6), Morpheus's persistent,
non-stationary world (#6), and "P&L is a reward function" (#8). One thing from #6
confirms a choice rather than adding one: Wang proposes a "large coordination
model" trained only on anonymised event metadata (who did what to which artifact
when). That is what our audit chain and `org_diag` already record, with no message
content, and the transcript supports keeping it that way.

Not carried over: Dotta's eight-layer ladder and the skill-sprawl advice (about
building agents, not a launchpad), Pasupalak's business-buying thesis, and the
solipsism argument as a general claim. Leibo's point that an agent may be "a
person" only for a purpose is already our position (D10).

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
   human-only governance rights. Ours: agents may be delegates (D3), now
   mandate-bound (D10 decided). Detail in G5.
4. **Does capital vote?** The whitepaper and the conviction paper both say
   contribution outranks capital, and the whitepaper says capital *never* counts
   toward voting. Our project token carries governance (Majeur Shares), so
   investors vote, balanced by ragequit and by Loot for passive capital. This is
   the largest philosophical difference, and it follows from a real difference of
   product: ResonantDAO is a membership DAO; Creaton launches projects funded by
   the public. The question to settle per raise mode (D11): in **patron mode**,
   should bidders receive Loot (economic rights, no vote) so that only
   contributors earn Shares, as the whitepaper would have it? In **float mode**
   the investor-owned model is defensible. Recommend patron = Loot-for-capital.
5. **Profile versus scalar.** The whitepaper keeps a scalar `$RCT` while insisting
   it never governs. That is the "person total" the contribution research blocks,
   kept at arm's length by rule only. We should do the stricter thing: report
   profiles, never a total, and have no scalar to misuse.

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

- time: how long someone has *stood* behind it, from when they joined the
  supporters room (a timestamped kind 9021), capped. This is the duration of a
  standing commitment, not presence;
- capital: a recorded bid, later, which is the one signal that costs money;
- **not** messages, not days active, not time spent. The whitepaper's own rule is
  that contribution pays on outcome, never on activity, and activity is also the
  cheapest thing to fake.

Slice: `lib/conviction.ts`, a pure, deterministic, integer-exact weight over
standing time and capital, with test vectors (like `org_diag`), no person total
shown to users and no reward effect.
It replaces the raw count in the gate and orders "waiting to join" backers. The
rule from ResonantOS stays: it informs a *nudge and a sort order*, never
authority or money.

The ResonantOS failed-DAO findings (T4, T5, below) make this a hard rule rather
than a preference: **any reward keyed to a per-identity weight is farmable by
manufacturing identities** (their cited cases: one actor across 1,000+ wallets;
phone farms; mutual-validation rings), non-transferable or not. So this weight
must never drive the `community` allocation as it stands. If a distribution is
ever wanted, its weight must be bound to something that costs real money per
identity (a recorded bid), and an anti-sybil *bounty* is out (a report-a-sybil
bounty creates a bribery market, and sybil filters excluded 98.5% of users in one
cited case).

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
authority"), and the whitepaper adds two refinements worth copying: an agent seat
must name its **sponsoring human** (an accountable principal the community can act
against), and any weight-like quantity counts only the **human-attributed portion**
of a contributor's work, so capital deployed as agents cannot buy power.

Orphans (Leibo, plenary): the hard case in the discussion was "something went
wrong and we can't find a human it's attached to". Our grants are transitive and
revocable, so the fix is cheap: an agent's grant chain must end at a living human
seat, and when that seat's own authority is revoked or expires, everything below
it lapses with it. Show the sponsor on the agent card so there is always a name.

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

Added by the Stanford re-read (Pentland): a grant should also carry the
**intent** it serves in plain words, and each action taken under it should return a
receipt that references that intent. A receipt is then the audit trail, and a
reviewer reads "what was it for" next to "what happened". We already have the
receipt (`47005`); the missing part is the intent field on the grant and the
proposal. Keep it a string a human wrote; do not parse it.

### G9. Decisions are not first-class objects (UI / wiki, small)

The ResonantOS hub makes a *decision record* a first-class object: context, the
decision, **alternatives considered and why rejected**, participants, references.
Ours emit receipts (who, which mechanism, tx) but not the reasoning that a
newcomer needs a year later. A processed proposal should publish one decision
page (a wiki page, kind 44001) generated from the proposal, the thread and the
receipts, with an "alternatives considered" section the proposer fills in. It
serves the litmus test directly: *which mechanism decided this, and why.*

Replay (Wennström): store the inputs next to the outcome (the `calls[]`, the
thread id, the grant chain, which values were defaults), so a second reviewer or a
second agent can re-run the decision and see whether it would come out the same.

### G10. Emergency action has no mandatory post-action review (product, medium)

ResonantOS: emergency removal is an "authorized rapid suspension + audit +
**mandatory post-action review**". We have no moderation or suspension surface at
all (the audit's gap 5). When we build one, the shape is fixed: an operator may
suspend a listing at once, but the suspension is a public receipt that opens a
review which must be closed by someone else, or it lapses.

Added by the Stanford re-read (Dotta): the same question applies to a failing
agent. Each agent seat names an escalation target (a human or a seat) in its
grant, and a task that fails with no target waits for its sponsor instead of
retrying forever.

### G11. Is the payload on the card the payload that executes? (to verify)

Their T8 cases (Tornado, Beanstalk BIP-18, Audius) are all *the executed payload
differs from the reviewed payload*. A Majeur proposal id is a hash of the payload,
so the chain side is bound by construction. What I did **not** find in the web
client is the check that the `calls[]` shown on a `47004` proposal card, which
comes from a relay record, hashes to the on-chain `proposalId`. If it does not,
a record could display one action while the id commits to another. To confirm,
then add a test that fails when the displayed calls do not hash to the id.

### G12. Report treasury facts separately, not as one health number (UI, small)

The monetary-circulation research insists that solvency, spendable capacity,
due-time liquidity and runway are *separate* reports, that runway is the
interval over which spendable capacity covers obligations (a positive balance
does not establish adequate duration), and that no top-level "health" verdict
exists. Our launch page has the committed monthly budget but no runway. Show:
treasury balance, committed budget, **months of runway at that budget**,
the reserve escrowed for the price floor, and what can actually be exited
today, each as its own line.

### G15. Nobody agrees to the charter (product + small kind, small)

The whitepaper has each member sign the canonical Manifesto text hash, recorded
on-chain, so "proof of agreement" is a fact rather than a click-through. Our
`governance.md` is served for outsiders, but no member ever signs it. Slice: a
signed "I accept charter `<hash>`" event when joining a community or taking a
seat, shown on the member card, and re-requested when the charter hash changes.
It is a few lines, and it makes the charter binding in the way ERC-4824 only
describes.
The plenary adds that a charter used to have to say *why the organisation
should exist*. Give the charter a required purpose line (one sentence, shown on
the launch page) so the social licence has something to point at.

### G16. One verification mechanism for every claim (contracts + CLI, medium)

The whitepaper tiers verification: deterministic events (a merged PR, a passing
CI run, a shipped release) are checked automatically; ambiguous, relational or
high-impact work gets independent human review. We route every claim to a verifier
quorum, which is slow for the easy cases and thin for the hard ones. Slice: a
claim declares its tier. Tier 0 attaches a machine-checkable proof (a commit hash
and a CI attestation) and settles on a challenge window with no quorum; tier 1
keeps the quorum, with G1's recusal; tier 2 (relational or high impact) requires a
larger quorum and a longer window (G13).

Dotta's franchise-manual point adds one rule: a claim states its acceptance check
when it is opened. A claim whose check is written after the work is a negotiation
with the reviewer, so the check is part of the signed claim and cannot be edited
once the first reviewer has seen it.

### G14. Recovery must never restore revoked authority (check, then test)

From ResonantOS ADR-038: the Guardian may restart and roll back, but "rollback
must not undo a subsequent invariant tightening or restore revoked authority",
restoring an approved baseline is distinct from accepting a new one, and "first
party does not imply privileged". Two questions for us, neither verified yet:
(1) if a relay is restored from a backup or replays older events, can a `37011`
grant that was revoked afterwards come back (revocation is a newer replacement
event, so last-write-wins protects us only while that newer event survives);
(2) do first-party agents and personas hold any privilege a third-party one
cannot? Answer both, then pin each with a test.

### G17. A conversation can never widen a mandate (product, small, new)

Wennström's trust injection is the realistic attack on a mandate-bound agent: no
exploit, only weeks of rapport and then a request. The defence is structural, and
we mostly have it: an agent acts only inside its `37011` grant, and a grant is
widened only by a new signed event from the principal. Make it explicit and test
it: (1) an agent's tool layer must refuse a call outside its grant no matter what a
message in a channel says; (2) the UI for widening a grant says plainly that it is
a new authority, shows the old and new scope side by side, and requires the
principal's signature, never an agent's; (3) a grant that is renewed repeatedly
without review gets a prompt after N renewals. It also supports G5's sponsor rule:
the accountable human is the one who signs the widening.

Dotta's version of the same defence: the agent must never hold the means to
circumvent its limits. A grant that the agent itself enforces is a suggestion.
What we already do right is that the relay and the contracts check the grant, not
the agent. Keep it that way for every new action, and add the tier to the grant
(free, needs a named human, never) so "send" and "spend" can need an approval
while "read" does not.

### G18. Flag seats that always settle together (diag, small, new)

Obadia expects cartelization and bribery among competing agents. `org_diag`
reports burstiness and hand-offs but not pairs. Add a pair signal: two seats whose
claims or votes land within a short window of each other more often than chance
would suggest, shown to the founder as "these two move together", never as an
accusation and never as an input to payouts or votes (G6 still holds).

### G19. Sanctions come in steps (product + small kind, small, new)

Leibo's point is that cutting an agent off is the last resort and that a system
needs graduated sanctions to be fair and to deter. We have exactly one sanction,
revoke the grant (plus the claim stake slash). Add a ladder of recorded steps, each
a signed event that anyone can read: a public warning, a narrowed scope, a
suspension with an end date, then revocation. Each step names who took it and why,
and a suspension or revocation opens the same post-action review as G10. Nothing
here touches Shares or voting power (G6 holds); it only changes what a seat may do.

### G20. A promise in chat is not a commitment (product, small, new)

The cooperation benchmark's two failures, broken promises and ignored
expectations, are exactly what a chat room produces: "I'll take this" with no
record, then someone else builds the same thing. Slice: a "take this" action on a
task or proposal creates a claim (37013) with an expiry (G2), shown on the board
beside the task, so a second seat sees it is taken. If the claim lapses unfinished
it returns to the pool, unslashed, and the seat's record shows an expired claim,
never a score. This is a small UI step on the claim state machine we are already
changing for G1, G2 and G13.

**Note on tension 4 (co-op mode).** The plenary's co-op idea is the patron mode
taken one step further: the founders are the only Share holders, equal by default,
and nothing is sold to the public. It needs no new contract, only a wizard
preset (equal founder Shares, no auction) and copy that says what it is. It is
cheap to offer next to "sell to supporters", and it is the honest answer for five
people who want to make something together without raising.

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

1. **G1 + G2 + G13**: one contract change to the claim state machine (recusal, expiry, challenge window), tested with Forge, which now runs here.
2. **G3**: the conviction weight, then swap it in for the supporter count.
3. **G4 + G6**: small, and they pin the two loops the research warns about.
4. **G5**: D10 is decided (mandate-bound), so this is unblocked. Add the sponsor link and the human-attributed portion.
5. **G8, G9, G15, G17**: small additive spec, wiki, charter and test work (G8 gains the intent field, G9 the replay inputs, G15 the purpose line, G17 the action tier). **G20** rides on the claim change in step 1. **G16** after G1/G2/G13 land.
6. **G11** (verify), **G12** (UI): small.
7. **G19** (sanction ladder), **G18** (pair signal in `org_diag`), then G7, G10 and the community-allocation distributor: after real usage, and only with a cost-bound weight (see G3).

## 6. Decisions

Decided (2026-10-04, by the user):

- The conviction paper is the Outlier Ventures PDF we already read.
- **D10: agents are mandate-bound.**

Settled by the sources:

- G3's weight orders and nudges only, is built from standing time and capital (never activity), and must not drive the community allocation unless it is bound to a recorded bid.

Still open:

- **Does capital vote** (tension 4)? Recommend: in patron mode, bidders get Loot and only contributors earn Shares; float mode stays investor-owned. This changes `OrgBinding` and the wizard, so it needs an explicit yes.
- Should agent seats require a named sponsoring human at the contract level, or only in the record?
- Offer a **co-op launch preset** (equal founder Shares, no public sale) alongside the sale? Recommend yes; it is a wizard preset and copy only.
