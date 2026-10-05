# Funding, finance office and voting power: the plan

`draft` `plan` `web` `desktop` `cli` `contracts`

Branch: `claude/org-graph-social-token` (cut from `claude/org-graph-social` at
`615949a4`). Nothing in this plan is built yet. It records decisions made with
the product owner, what is still unverified, and the order to build in, so any
later session can continue without the chat history.

Related: [legitimacy-synthesis.md](legitimacy-synthesis.md) (gaps G1 to G20 used
below), [token-lifecycle-design.md](token-lifecycle-design.md),
[agentic-governance-design.md](agentic-governance-design.md),
[web-mvp-audit.md](web-mvp-audit.md).

## 1. What we are building

A DAO launchpad with accountability and agents built in:

1. Every project shows an honest **funding status**, and discovery filters by it.
2. A project can fund itself in **four ways**: auction, open sale, contributors
   only, or milestone **proposal funding** (entry voice through vouchers).
3. A project that is raising gets a **finance office**: a preset of channels and
   agents in the desktop app, tied to treasury rules the contracts enforce.
4. Agents always have a **human sponsor** who is paid for, and answerable for,
   what the agent does.
5. Voting power **grows with time held** and cannot be sold.
6. A **whole-project simulation** proves the pieces work together.

## 2. Funding status (web, no contracts)

Two separate fields on the launch record. The existing technical `stage` (draft,
review, live, funding, graduated, failed) stays as it is.

| Stance | Meaning |
| --- | --- |
| Not raising | Self-funded or community-run |
| Planning a raise | Intent; optional rough date |
| Raising now | A sale is open |
| Closing the raise | Final stretch or settling |
| Raise closed | Raised, not raising |
| Rolling round | Ongoing or open-ended funding |

`seeking`: any of contributors, backers, advisors. A project can be "Not raising,
looking for contributors".

Rules:

- A declared stance stands, including intents like "Planning a raise" that have
  no onchain state yet.
- Chain state only overrides when it contradicts the declaration: a live sale
  shows "Raising now" even if declared "Not raising"; a finished sale moves on to
  "Closing the raise" then "Raise closed".
- A "Planning a raise" older than 30 days gets a nudge to update.
- Discovery gets filter chips with counts for stance and for `seeking`, a badge on
  every card, and "Raising now" first by default.
- The finance office is offered from "Planning a raise" onward and set up
  automatically at "Raise closed". "Not raising" projects see only the team room,
  supporters and contributor tools.

Store as `content.funding = { stance, seeking[], opensAt?, note? }` on the launch
record (kind 37001). Copy follows the user-facing copy rules in `CLAUDE.md`
(plain words, no protocol terms).

## 3. The four funding paths (wizard step "How do you want to fund this?")

1. **Auction.** Built (CCA).
2. **Open sale.** A continuous raise: fixed price with a cap, or a bonding curve
   (Majeur ships `ShareSale`, `BondingCurveSale`, `ClassicalCurveSale`). Purchases
   are final. Funds may unlock in tranches as milestones are verified. A buy fee
   goes to the treasury.
3. **Contributors only.** No sale. People join by contributing (Majeur `Tribute`),
   claims and royalty schedules. Shares are earned by work. Includes a **co-op
   preset**: equal founder Shares, nothing sold publicly.
4. **Proposal funding.** Investors pledge, then direct their money to proposals
   (section 4). Includes conditional pledges ("invest only if this proposal
   passes") as a trigger type.

Ship in slices: each path turns on in the wizard when its contract and its
simulation scene are ready. "Version 1 complete" means all four are live.

## 4. Proposal funding: vouchers and the proposal vault

Decided with the product owner. This is **entry voice**, the mirror of ragequit:
ragequit is the voice to leave, vouchers are the voice to enter.

1. **Pledge.** An investor deposits currency into the **proposal vault** (outside
   the DAO treasury and outside ragequit) and receives **vouchers**, 1 per
   currency unit. Vouchers are soulbound apptokens (Transfer Validator Soulbound
   ruleset): not transferable, no treasury claim, no votes. Existing token holders
   can buy more vouchers.
2. **Direct the funds.** The investor spends vouchers on the proposals they back.
   The money moves to that proposal's milestone reserve, minus a customizable tax
   that goes to the treasury.
3. **Get the stake.** At the moment of spending, the investor receives project
   tokens at the join price. The vault holds them until the milestone is verified.
   If it fails (rejected or expired), money and tokens go back to the investor
   (refund, not slash-to-treasury as `ClaimStake` does today for rejected claims).
4. **Unspent vouchers** are refundable at any time, and refunded automatically
   when the project ends or the voucher expires.
5. A funding proposal states: purpose, minimum and maximum amount, deadline,
   milestone check written up front (G16), verifiers, and a join window. Below the
   minimum at the deadline, everyone is refunded.

Why vouchers and not project tokens at pledge: real tokens at pledge could be
ragequit at once against the treasury's existing money while the investor's own
funds sit in the vault.

**Join price** (removes the free-option problem): the highest of the pledge-time
price (a floor), the market average at join time, and the treasury's value per
token. Before a token has a market, it is just the pledge-time price. An optional
early-supporter discount (default 5%, capped, visible) may apply, but the price is
never below treasury value per token (otherwise buy-then-ragequit is free money).

Price sources by situation:

| Situation | Price source | Free-option risk |
| --- | --- | --- |
| During an auction | Clearing price | None; bid directly, vault unused |
| Open sale or curve | The sale's own price | None; purchases are final |
| After graduation, platform token | Pool average (window of at least one day) | Yes; use the join price rule |
| Existing token, liquid pool | Configured pool average | Yes; same rule |
| Existing token, no real market | Fixed price the project sets | Small |

A pool with thin liquidity or short history counts as "no market".

Design details for the contract note: voucher expiry; voucher is a stable 1:1 unit;
the treasury should hold one raise currency so payouts are clean; payout timing
versus lock-time value; unspent vouchers carry no governance weight (avoids farming
with refundable money).

A securities caveat: active allocation may help an argument that this is not a
passive investment, but investors still expect profit from the team's work. Do not
rely on it or market it that way. Get counsel before any real raise.

## 5. Tokens: apptokens, and what to do with Majeur

Context found while planning:

- Today the auction sells the project **TokenMaster apptoken**. Nothing in
  `contracts/src` hands bidders Loot, so "bidders get Loot" was never built.
- TokenMaster's Standard Pool is the token itself (a reserve-backed token with a
  curve and a floor). Its pool has the router address built in, and the router only
  lets factories approved by its admin authority deploy tokens. A merged
  Majeur-plus-TokenMaster contract would not work with the canonical router unless
  approved. **We will not merge sources.**
- Majeur's `Shares` and `Loot` functions are not `virtual`, so they cannot be
  subclassed. Any change is a small in-place patch to a copy of `Moloch.sol`.

Two coherent designs; **leaning B**, spike first (section 11):

| | A. TokenMaster token plus Majeur governance (built today) | B. Loot and Shares are the apptokens |
| --- | --- | --- |
| Project token | TokenMaster apptoken | Loot, sold in the auction, tradable under transfer rules |
| Investor exit | TokenMaster floor only | Majeur ragequit at treasury value per token |
| Investor votes | Stake in a vault; votes grow | Computed in Loot from time held; no staking step |
| Contributors | Shares with ragequit | Shares, earned, non-transferable |
| Weakness | Contributors exit at treasury value, investors at the floor | Rework of sale and graduation; bigger Majeur patch |

B gets a floor (ragequit) and a curve (Majeur curve sales). It loses only the
TokenMaster router's signed orders, the demand fee tied to target supply, and
buy/sell/spend hook calls. Must-haves from the product owner and how B covers them:

| Wanted | In B |
| --- | --- |
| Fee revenue (a tax to the treasury) | Fee in the curve-sale contract; an LBAMM hook on pool trades; a skim when vouchers are spent. Every fee has a maximum fixed at deployment, founder-customizable below it. Ragequit stays fee-free |
| Creator emissions | An emitter mints at a set rate with a hard cap that only goes down, **to the treasury only, never to a person**, via Majeur's allowance mechanism. Spending them still needs budgets or verified milestones |
| Transfer rules | Transfer Validator on Loot and Shares. Default mode **Pool-only**: no wallet-to-wallet transfers, selling through an approved pool. Other modes: Closed (vault and ragequit only), Open |
| Spend flows | The voucher mechanism in section 4 |

Plain ERC-20s that a project brings are **wrapped** into an apptoken (the Creator
Token Standards have a wrapper to confirm in the spike). Three integration levels,
shown as a protection badge on cards:

1. **Listed:** project page and discovery only.
2. **Treasury-linked:** the project registers its existing treasury (for example a
   Safe); the vault pays out to it; the project pre-funds a token allotment (no
   minting rights needed).
3. **Full DAO:** Majeur-bound, with ragequit and voting power that grows.

## 6. Voting power that grows with time held (design B)

- Clock: block number (matches Majeur snapshots). Window `T` in blocks, per chain.
  Default 12 months, linear, maximum 1 vote per Loot.
- A holder's votes at block `b` = `min(average Loot balance over the last T blocks,
  Loot balance at b)`, plus Shares earned by work. This is exactly additive across
  wallets (splitting or merging gains nothing), a flash buyer gets nothing, and
  selling cuts votes at once.
- Needs a balance-history checkpoint (balance and running balance-time total) per
  Loot move. Quorum is measured against fully matured supply.
- Earned votes are **not delegable** in version 1. A sponsor's agent votes through
  the sponsor's smart account under a limited session key.
- Shares: transfers locked.
- Implementation: a copy of `Moloch.sol` with the patch confined to marked regions
  of `Shares` and `Loot`, plus a CI check that the copy differs from upstream only
  there.
- Invariant (G6): no score, activity count or reputation can feed voting power.

## 7. Finance controls and agents with human owners

Reason: today one treasury address can fund claims, pick verifiers and freeze
claims, and `ClaimStake.payout` is open right after approval.

Contracts, in one change to the claim state machine:

- **G1** reviewer recusal (a claimant cannot attest), and the DAO nominates
  verifiers, not the treasury owner.
- **G2** claim expiry, returned unslashed.
- **G13** challenge window before `payout`.
- **G16** claim states its acceptance check when opened; locked once a reviewer
  has seen it.
- **G20** "take this task" creates a claim with an expiry that other seats can see.
- **Founder budget cap**: an enforced cap with a vote-gated default (the
  MetaDAO-style envelope), replacing text-only budget commitments (G7).
- **AgentRegistry**: the sponsor signs for the agent's address. `ClaimStake` gets
  a `payee`: for a registered agent it is forced to the sponsor, and the sponsor
  posts the stake and takes any slash. Agent-earned rewards pay the sponsor in
  currency or Loot, never as instant votes. An agent's grants lapse when its
  sponsor's authority does (orphan rule, G5).
- Later: G17 action tiers on grants (free, needs a named human, never), G19
  sanction ladder, G18 pair signal in `org_diag`, G10 emergency action with review.

## 8. Launch Studio preset (desktop, CLI, templates)

Reuses the existing `templates/<id>/template.yaml` mechanism (`buzz templates
apply`: channels, personas, workflows, docs, skills, org seats, default budget;
idempotent and resumable). Limits: 8 channels, 6 personas, 6 workflows.

One preset, **Launch Studio**:

- Channels: the team room plus `#finance`, `#claims`, `#decisions`.
- Agents with narrow roles: Treasurer (runway, budget proposals), Controller
  (matches onchain payments to signed records), Claims Clerk (evidence summaries
  for verifiers; advises, does not approve), Guardian (odd spending, seats that
  move together), Launch Guide (answers "what next?" from checklist state).
- **Powerless by default**: the Treasurer's spending ceiling starts at zero; each
  persona prompt states what it cannot do.
- Workflows: weekly runway report, claim-review loop, monthly founder-update
  reminder, launch-day checklist.
- Docs: Finance Policy (who can spend what; members accept it) and Treasury
  Playbook.
- Applying it to a launch records the finance office on the launch record
  (`content.chat.finance` or an `office` field) so web and desktop both find it.

Founder "Start here": the web checklist extends to idea, set up the sale,
commitments, **finance office**, **invite verifiers**, go live, **first
milestone**, **weekly runway check**. On desktop it appears on Home and in the
Launch Guide's welcome message. On web the finance-office step opens the desktop
app through the deep link (agents run locally), with a web-only fallback (policy
doc and manual steps). Agents need the desktop app's local runtime in version 1.

## 9. Whole-project simulation

A scripted story runner instead of more isolated tests, run with one command
(`just simulate`), on a real relay and Anvil with time jumps.

- Cast: founder, three backers, two contributors, an agent and its sponsor, two
  verifiers, and a troublemaker.
- Happy path: idea, supporters, stance changes, raise, graduation, finance office,
  budget lines, milestone claim, challenge window, payout, voting power growing,
  proposal, ragequit.
- Other scenes: failed raise with refunds; contributors-only project; open sale;
  proposal funding with vouchers (joined, unjoined, failed milestone); imported
  token; orphaned agent; attacks (self-approval, split wallets, flash buyer,
  buy-then-ragequit).
- Checks at every step: treasury solvent, supply conserved, no spend beyond an
  allowance, exits neutral.
- Output: a timeline report with screenshots per stage. Each feature adds its own
  scene as it lands. Start from `web/tests/e2e-real/journey.spec.ts`.

## 10. Order of work

1. **Stance, `seeking`, discovery filters, simulation skeleton** (web only, no
   contracts).
2. **Launch Studio preset**, gated on stance.
3. **Spike** (section 11), then lock A or B.
4. **Finance controls** (contracts, section 7).
5. **Voting power growth** and apptoken Loot/Shares (design B patch).
6. **Proposal vault and vouchers**, then **open sale** and **contributors-only**.
7. Imports (wrapped tokens, levels 1 to 3).

Every step lands with its simulation scene, `just ci`, and Forge tests with
mutation checks as in `docs/audit-readiness.md`. Do not put real money behind the
Majeur patch or the vault before an external review.

## 11. Open items and the spike

Throwaway Forge tests on this branch, no production code, to verify:

1. Majeur's cloned Loot and Shares can be registered with the Transfer Validator
   (it expects a collection owner).
2. The CCA auction and the LBAMM pool accept Loot as the sale and pool token.
3. A vault can call Majeur's `ragequit` as the holder of record and route the
   payout, with an unlisted token ordering as the contract requires.
4. The Creator Token Standards wrapper exists for plain ERC-20s.

Still to decide:

- Design A or B (leaning B).
- Ragequit rules right after a raise (a lock period, or only open while a
  proposal is pending). Money reserved for milestones sits outside the treasury
  and is protected either way.
- Whether to offer an optional "donate my share" (burn tokens to fund a proposal).
  It is a donation, not an investment: the donor gives up their stake while
  non-spenders keep theirs.
- Default fee numbers (founder-customizable within deploy-time maximums).
- Voucher expiry length.

## 12. Decisions already made

- Conviction paper is the Outlier Ventures PDF already read.
- D10: agents are mandate-bound, and every agent has a human sponsor who is paid
  and answerable.
- Earned votes grow with time held and cannot be sold; no staking step in B.
- Pool-only default transfer mode; emissions go to the treasury only; fees are
  customizable within deploy-time maximums.
- All four funding paths are in version 1 (shipped in slices).
- Chain truth only overrides a declared stance when it contradicts it.
- Tokens at funding with clawback; join price rule; vouchers are soulbound entry
  tokens.
- Finance first (controls and preset), then voting power, then proposal funding.

## 13. Handoff notes

- Credentials: the Sepolia RPC URL pasted earlier in chat must never be committed.
  Use the environment secret `SEPOLIA_RPC_URL`; rotate the key.
- Toolchain tricks (forge via npm packages, solc binaries, real-relay stack,
  Playwright configs) are described in the earlier session notes; the stack
  script is `/var/lib/postgresql/stack-up.sh` and builds use
  `VITE_LAUNCHPAD_CHAIN_ID=31337`.
- Known failing or pre-existing items not caused by this work: about 11 smoke
  specs, 3 older `real-relay.spec.ts` tests, the `WikiView.tsx` file-size ratchet,
  and a `buzz-skillopt` clippy warning.
