# creabuzz — a DAO OS

> Agentic Slack + a DAO launchpad, wired into one loop. This is the product
> contract the code is held to. Where an older plan (`ORG_COMMUNITY_PLAN.md`,
> `docs/dao-launchpad-plan.md`, `docs/next-gen-launchpad-plan.md`) disagrees
> with this file, this file wins.

## What it is

A community on a relay is a workspace: channels, threads, a wiki, humans and
agents. creabuzz adds the parts that turn a workspace into an organization
that can raise money and be owned: an org chart humans and agents sit in,
budgets that bound what agents may do, a token sale that funds a treasury, and
a DAO that governs it. The relay stays the record; the chain stays the ledger
for money.

## The loop

1. **Start.** A founder applies a project template: channels, agent
   personas, workflows, wiki pages — and now the org: a founder seat and a
   default budget for every agent.
2. **Staff.** Agents are employees. Each sits in a seat and is covered by a
   budget from the moment it joins; nobody has to remember to configure one.
3. **Work.** Humans and agents talk in channels, create tasks, and write the
   wiki (human pages and agent pages). Every agent action is metered.
4. **Approve.** When an agent hits its budget the overrun becomes an approval
   card in "Needs me" with a human's name on it. Approving lets the retry
   through; the decision is on the audit chain.
5. **Fund.** The project launches a token: one guided flow mints the token,
   deploys the auction, funds it and binds the settlement contract. Sandbox
   (simulated) first, testnet next, mainnet only behind an explicit switch.
6. **Govern.** The raise settles into a treasury owned by a majeur DAO.
   Shareholders can always ragequit.
7. **Reward.** Contributions — by people and agents — are drafted, reviewed by
   a human other than the contributor, and feed shares, royalties and budget
   ladders.

## Design rules (the wiring contract)

- **R1. One anchor of authority.** Owner → seats → agents. Only the
  community owner/admin, or a holder of an *anchored* parent seat, may create
  or change org nodes, grants and budgets. Grant chains are verified at
  ingest by default and resolve parents by *who signed them*, never by id
  alone.
- **R2. Budgets bind every agent by default.** A community default budget
  (`subject: "*"`, owner-signed only) covers any agent without its own.
  Counters are runs, tasks, proposals, messages and LLM calls. Windows are
  fixed epochs (86,400 / 604,800 / 2,592,000 s) so the relay, the contract and
  the UI agree. Overrun → durable approval request, never a silent stop.
- **R3. Money is enforced where money moves.** The allowance contract holds
  the ceiling and the payout path (`spendTo`); the relay's records are a
  mirror. A ledger that a key can bypass is labelled advisory.
- **R4. Launching is one flow with safe defaults.** Token fee ceilings are
  low and owned by the DAO; the settlement executor is bound to exactly one
  auction; the reserve cannot be pulled before a lock expires; mainnet is
  off unless `VITE_ENABLE_MAINNET` is set, and the UI says "unaudited".
- **R5. The wiki is the DAO's memory, and it is safe to give agents.** Human
  pages are kind 44001, agent pages 44002. Anything an agent or a relay job
  reads on behalf of the community is limited to what every member could
  read. Live co-editing is authenticated: every update carries the signer's
  key and is dropped unless the signer is a member.
- **R6. The relay is still a pipe.** LLM calls happen in clients and
  harnesses. The two relay-side exceptions — the LLM gateway and the
  `distill_agent_wiki` job — are opt-in, rate-limited, and read only public
  channels.
- **R7. Honest surfaces.** Each screen says whether a rule is enforced or
  advisory. No fabricated numbers. Testnet by default.

## Enforced vs advisory

| Rule | Where it bites |
| --- | --- |
| Who may write org nodes, grants, budgets | Relay ingest (always) |
| Grant-chain attenuation, root standing | Relay ingest (default on; `ORG_GRANT_ENFORCEMENT=off` to disable) |
| Run / task / proposal / message / LLM budgets | Relay ingest and gateway |
| Spend ceilings | `OrgAllowance.spendTo` on chain; advisory without it |
| Reviewer ≠ contributor for the autonomy ladder | Relay ingest and ladder query |
| Role-scoped reads (`readBelow`, `assignBelow`) | **Not implemented.** Channel membership is the only read gate. |

## Not now

Role-scoped read gates, futarchy, per-jurisdiction compliance, and anything
that needs a legal opinion before real money. The launchpad stays
testnet-only until the contracts are audited and a legal posture exists.
