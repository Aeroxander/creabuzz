# Token and voting power: the decisions

`draft` `decision` `contracts` `web`

Companion to [funding-and-governance-plan.md](funding-and-governance-plan.md) §5–§6,
which this **replaces on the voting-power question only**. That plan is the
authority for the four funding paths, the proposal vault, and the finance
controls; the other `docs/*-plan.md` notes are background and are not binding.

Everything here is decided. Items still needing a spike are listed in §8 and
are questions of *cost*, not of direction.

**Status:** the vault, the weight seam and the Majeur fork patch are built and
tested (`contracts/src/ProposalVault.sol`, `VotingWeight.sol`,
`majeur/MolochPatched.sol`). The web funding declaration and the
backer-facing panel are built. Still open: wiring the panel to a deployed
vault, and a proposal-funding scene in the simulation.

---

## 1. The question

Design B (plan §5) makes the project token and Majeur's `Shares`/`Loot` the
same thing: `Loot` is sold in the auction and traded in the pool, `Shares` are
earned by work. The plan then said voting power should **grow with time held**.

That rule is wrong for this product, and the objection is the one that matters:
*holding is costless once you have bought.* A rule that multiplies weight by
time-passed rewards parking capital and entrenches whoever arrived first. The
product's own promise is the opposite — every project shows an honest funding
status, backers direct money to proposals rather than to whatever the team
fancies (plan §4), and work is what earns a seat at the table.

So the rule becomes: **weight follows capital you directed and work you
delivered. Not capital you parked.**

## 2. What "vouching" means here

Not a reputation point, not a score, not an entry in a participation graph.

A backer deposits currency into the **proposal vault** and receives **vouchers**
1:1 (plan §4). Spending vouchers on a proposal is **backing** it: the money
moves to that proposal's milestone reserve, minus a tax to the treasury. That
act — directing capital somewhere the team would not have put it — is the
participation the product is about.

This matters for the invariant. [legitimacy-synthesis.md](legitimacy-synthesis.md)
G6 says *no score, badge tier or activity count may feed voting power*, and it
is enforced by a source-scanning test. Backing is not a score: it is capital
that can be lost. The governing principle is the one the research notes already
reached — **we slash stake, not reputation** — so G6 holds, and no design below
reads any score in a weight path.

## 3. The weight model

For account `a` at snapshot block `b`:

```
votes(a, b) = work(a, b)            // Shares, Majeur's existing machinery
            + held(a, b)            // Loot held, flat
            + backing(a, b)         // Loot committed to proposals, compounding
```

**Work.** `Shares` earned by verified work. Weight is Majeur's `getVotes` as
built — delegatable, checkpointed, split-delegatable. No change. Work is
converted to shares through milestone claims carrying a written acceptance
check and named verifiers (plan §7 G16), so it is *verified delivery*, never an
activity count.

**Held.** `Loot` balance at the snapshot, 1:1, **no growth**. Buying at the
auction or in the pool gives you ownership and nothing more; waiting earns
nothing.

**Backing.** The new term. For each proposal `p` the account has committed
`Loot` to and that `p` has not yet resolved:

```
backing(a, b) = Σ_p  escrowed(a, p) × (1 + min(age(a, p, b) / T, 1))
```

`age` is blocks since the commitment, `T` is the same 12-month window the plan
named. So a commitment earns its stake back plus at most 100% more: **at most
2× the escrowed amount**, and only while the capital is actually at risk.
Backing weight is per-proposal — it buys you voice over *the decision you
paid to influence*.

Four properties this has to have, and does:

| Property | Why it holds |
| --- | --- |
| Passive holding earns nothing | `held` is flat; only `escrowed` compounds |
| Flash buyers get nothing | buying `Loot` gives `held`; `backing` requires escrow |
| Splitting or merging gains nothing | `backing` is summed over (account, proposal) pairs |
| Weight cannot be sold | `backing` is tied to escrow, which is not transferable |

Unspent vouchers carry **no** weight — already decided in plan §4, and it is
load-bearing here: refundable money must never vote.

## 4. The two tracks stay separate in kind

`Shares` is a claim on the treasury earned by delivery. `Loot` is an
investment. They add into one tally but they must not blur:

- **`Shares` stays delegable** — it already is, with split delegation across up
  to four delegates. Deleting that would be throwing away working code to
  satisfy a sentence in a plan.
- **`Loot` and `backing` weight are not delegable.** Investment weight is a
  stake, not a representation. Someone who wants a say on a proposal moves
  capital behind it.

## 5. Quorum

The plan said "quorum against fully matured supply". With no maturation there
is no such quantity, and computing a backing-aware total is O(holders).

**Decided:** quorum is measured against `sharesSupply + lootSupply` at the
snapshot — the same two quantities the plan already snapshots. Backing weight
is *extra* weight above that denominator, so this is strictly harder to reach
than a backing-inclusive denominator. Conservative, cheap, and it never makes
quorum mathematically unreachable.

## 6. Exit discipline (the real security question)

Weight without an exit rule is a rate limit, not a protection. Plan §4 already
closes *buy-then-ragequit* with the join-price rule. The other direction is
currently open and must be closed in the same change:

**No exit while your weight is counted in a pending proposal.** `ragequit`
(plan §5) and release of escrowed tokens are refused for any account with
backing weight behind an unresolved proposal it has voted on. Until that
proposal resolves, the capital stays where the vote was cast.

Everything else — budget caps, the challenge window, verifier recusal, the
claim expiry (plan §7) — is what bounds what a proposal can actually move.
§3 buys a capital commitment; §7 is what stops that commitment being worth
making.

## 7. Where the code diverges from Majeur

We are **not** writing our own Majeur. `Moloch.sol` ships as one compilation
unit — `Moloch`, `Shares`, `Loot`, `Badges` — with the token implementations
created in the constructor and cloned by `create2`, so none of them can be
swapped without editing the file. The plan's discipline stands: **one fork,
patch confined to marked regions, and a CI check that it differs from upstream
only there.**

The regions, kept as small as the design allows — all implemented in
`contracts/src/majeur/MolochPatched.sol` as **additive-only** patches, so that
stripping them leaves upstream verbatim and `scripts/check-majeur-fork.mjs`
(enforced by `just majeur-fork-check`, part of `just check`) can prove it:

| Region | Change | Size |
| --- | --- | --- |
| `Loot` | balance checkpoints (`balanceOfAt`/`totalSupplyAt`) | ~60 lines, copied from `Shares`' existing mechanism minus delegation |
| `Moloch.vote()` | `weight = weightFor(id, msg.sender, snap)` | 1 line |
| `Moloch.openProposal()` | supply = shares + loot at snapshot | 1 line |
| `Moloch` | `weightFor()` + the exit gate | ~30 lines |
| `Shares` | **unchanged** | 0 |

Backing lives **outside** the fork, in a peripheral, following Majeur's own
`src/peripheral/` pattern (`ShareSale`, `Tribute`, `TapVest`, `ShareBurner`).
The fork reads it through one interface. That is what keeps the divergence
cost flat as the mechanism evolves.

Dropping time-weighting is what makes this cheap: no balance-time integrals,
no new supply aggregate, no per-account integral checkpoints.

## 8. Still to spike

Cost questions only — none of them change direction.

1. `Loot` checkpoints: storage growth under real pool trading, and whether
   entries older than the snapshot lookback can be pruned opportunistically.
2. Whether `backing`'s age term needs its own checkpoint array or whether the
   escrow record's start block suffices (it should).
3. The exit gate's bookkeeping: cheaply answering "does account `a` have weight
   behind an unresolved proposal" without an O(proposals) scan.
4. Whether `VoteCancelled` and the tally accounting survive a per-proposal
   `voteWeight` unchanged (they already store weight per proposal, so this is
   likely a no-op).

## 9. Decisions this supersedes in the plan

- §6 "votes grow with time held" → **replaced** by §3 above.
- §6 "needs a balance-history checkpoint (balance and running balance-time
  total)" → **replaced** by plain `Loot` checkpoints; no balance-time integral.
- §6 "earned votes are not delegable in version 1" → **narrowed**: `Shares`
  delegation is kept as built; only `Loot` and backing weight are
  non-delegable.

Everything else in that plan stands, including G6 and the join-price rule.
