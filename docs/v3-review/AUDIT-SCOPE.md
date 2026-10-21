# Audit scope: the milestone-locked raise

Status: prepared 2026-10-19 on branch `audit-groundwork` (from `v4-governance-rework` at `e72c8911b`). One contract
changed while preparing it, each with a failing test first and a DECISIONS row, after walking the ethskills checklists
(§10): a currency-blocked payee can no longer stall a milestone vote (D67) or strand a claim's reserve (D68), the claim
escrow works with currencies whose `transfer` returns nothing (D68), unclaimed sale Shares no longer count in the
voting supply (D69), and every first-party contract compiles with solc 0.8.37 (D70). Line counts in §2 are from before.
This is the groundwork for the external audit the roadmap requires before any raise goes live
([SOCIAL-MVP-ROADMAP-2026-10-19.md §5](SOCIAL-MVP-ROADMAP-2026-10-19.md)). Mainnet stays off until that audit is done
and its report replaces the "unaudited" notice.

**Updated 2026-10-21 for the tokenomics decisions (D72–D82, merged into `v4-governance-rework`).** They changed
`ragequit`, `Shares`, `Loot`, both milestone locks and both kits, removed seven functions from the patched DAO, and made
the lock factories constructor arguments of the launch kit
([TOKENOMICS-CONTRACT-CHANGES.md](TOKENOMICS-CONTRACT-CHANGES.md)). §1, §2, §4, §5 and §6 describe the contracts after
them; the ethskills walk in §10 was done before them, so the new code (§7, item 6) has had no checklist pass yet.

**Freeze before sending.** Tag the commit the auditors receive and pin it here. A change to any file in the table below
after the tag needs either a re-review of that file or a written reason why it is outside the money paths.

## 1. What a raise does, end to end

1. **Launch, one transaction.** A founder calls `DaoLaunchKit.launchChallenged` (milestones judged by holders, the
   default) or `DaoLaunchKit.launch` (a named reviewer panel). In that one call the kit:
   deploys a `GraduationExecutor` it runs (CREATE2 from the founder and the salt); summons the DAO through the patched
   Majeur `Summoner` with the team, the executor (the sale tranche) and the kit (the DAO's own allocation, passed on at
   once) as its only holders; in the DAO's own initialization points the Shares at the milestone lock
   (`MilestoneChallenge` or `MilestoneLock`, or "none" for a launch with no team, and the choice is final), names the
   review panel (panel launches only), holds governance closed until the sale's claim block, turns on the issuance rule
   (new Shares only from awards, at most 10% a year) and locks transfers with the auction exempt and a 30-day notice
   for unlocking; points the executor's payee at the DAO; and creates, binds and funds the auction on Uniswap's
   canonical continuous clearing auction (CCA) factory. Before any of it, the kit refuses terms outside the limits
   (`UnfairTerms`: sale at least 60%, team at most 35%, reserve at most 20%, every team Share behind 2 to 8 milestones of
   at most half each, no team seat that is a system address, a target of the whole tranche at the floor).
2. **Sale.** Backers bid on the CCA through Permit2. When the sale ends anyone calls
   `GraduationExecutor.executeGraduation`: a raise that met its target is swept into the DAO's treasury and unsold
   Shares go to the DAO; one that missed it refunds every bid in full from the auction (`exitBid`), and only the DAO
   can recover the unsold tranche.
3. **After the sale.** Buyers claim their Shares from the auction. From the claim block on, holders govern the treasury
   with `AllocationVoting` (the only ballot): payments, reviewed work budgets (`TreasuryMandate` with `ClaimStake` and
   bonded reviewers in `VerifierSet`), freezing and unwinding claims, taking a reviewer's bond, forfeiting a departed
   founder's tranches. Any holder can leave with their share of the treasury (`ragequit`) at any time; no vote can
   switch that off or burn a holder's Shares. The exit total leaves out the DAO's own Shares and the team's Shares still
   locked. Shares cannot be sent between wallets until trading is announced by one vote and opened by another, 30 days
   later.
4. **Milestones.** The team's Shares vote from the first block but the milestone-tied part cannot be moved or ragequit
   until its milestone stands: unchallenged after a public window, or confirmed by a holder vote that excludes the team
   (`MilestoneChallenge`), or approved by the named panel after a seven-day challenge window (`MilestoneLock`). A late
   objection within a month can burn every tranche still locked.

## 2. Contracts in scope

Lines are total and source lines (no blanks or comments) at `13b27b2c7`.

| Contract | File | Lines (source) | Role in the raise |
|---|---|---|---|
| `DaoLaunchKit` | `src/DaoLaunchKit.sol` | 517 (373) | The one-transaction launch: executor, DAO, lock, panel, auction, and the checks on the launch's terms (D74, D75). Takes the two lock factories as constructor arguments (its creation code had no room to carry them); 22,951 bytes of creation code. Compiled with solc 0.8.37 like the rest since D70 (before: 0.8.26, the CCA's pin). |
| `GraduationExecutor` | `src/GraduationExecutor.sol` | 459 (255) | Holds the sale tranche, funds the auction, sweeps the raise to the DAO, recovers a failed sale for the DAO. The kit uses it with `reserveBps = 0`, so its reserve paths are unused in a DAO launch. |
| CCA interfaces | `src/CCA.sol` | 66 (30) | Mirrored interfaces of the upstream auction; `test/PinnedInterfaces.t.sol` compares them with the pinned source. |
| Patched Majeur DAO | `src/majeur/MolochPatched.sol` (`Moloch`, `Shares`, `Loot`, `Badges`, `Summoner`) | 2,872 (1,645) | The DAO, its treasury, ragequit (leaving out the DAO's own Shares and those still locked, D72), the Shares ERC-20(C) with the lock guard (chosen once, "none" included), the issuance rule (mints and hand-outs only inside `awardContribution`, at most a capped share a year, D76), burns only inside `ragequit` (D73), and the transfer lock with one exempt address and a 30-day unlock notice (D77). `setRagequittable`, the share sale, permits and allowances are removed (upstream text kept in comments). Upstream is `lib/majeur/src/Moloch.sol`; the fork is additive: 89 `@@CREABUZZ PATCH` blocks, 584 lines inside them (`scripts/check-majeur-fork.mjs` enforces it). `Moloch` runtime 22,090 of 24,576 bytes; `Shares` 10,902. |
| `AllocationVoting` (+ `IVotingWeight`) | `src/AllocationVoting.sol`, `src/VotingWeight.sol` | 629 (465) + 21 (13) | The only ballot: snapshots of owned Shares, two lanes, quorum, approval, review, hold time, the governor's queue reset. Cloned per DAO. |
| `MilestoneChallenge` (+ factory) | `src/MilestoneChallenge.sol`, `src/MilestoneChallengeFactory.sol` | 550 (422) + 30 (21) | The default lock: publish with a bond, object with a deposit, holder vote without the team, late objection burns what is still locked, milestones in order and only after the month on the one before (D56–D58); keeps `totalLocked`, which the exit leaves out (D72). |
| `MilestoneLock` (+ factory) | `src/MilestoneLock.sol`, `src/MilestoneLockFactory.sol` | 206 (137) + 30 (20) | The panel lock: a tranche unlocks on a `Paid` claim in the DAO's named panel mandate; keeps `totalLocked` (D72). |
| `MilestoneBadge` | `src/MilestoneBadge.sol` | 118 (85) | Soulbound record minted on unlock. Moves no value. |
| `TreasuryMandate` (+ factory) | `src/TreasuryMandate.sol` | 416 (314) | Work budgets: a DAO-approved, finite budget in currency and/or Shares; projects; claim binding; reviewer slashing; closing. The factory is also where the panel is named. |
| `ClaimStake` | `src/ClaimStake.sol` | 444 (279) | Claim escrow: contributor stake, reserved payout, approval quorum, 7-day challenge window, freeze, unwind, expiry. |
| `VerifierSet` | `src/VerifierSet.sol` | 246 (166) | Reviewers, quorum, recusal, bonds with a 14-day unbonding delay, slashing by the owner (the mandate). |

About 4,250 source lines of first-party code, of which the patched Majeur is the largest piece.

**Adjacent, not in the raise path** (review if time allows; they share contracts above): `ContributorKit` (contributor
projects, no sale, D66; 250 (180) lines, refuses a founder stake above a third of the first budget and a founder on its
panel, sets the issuance rule with no yearly cap, D79; makes up to eight first projects in a bounded loop, each checked
and read back, D84), `OrgBinding`, `OrgAllowance`, `RoyaltyDistributor` (only reached through
`ClaimStake.submitClaimWithSchedule`, never wired in a raise), `ShareVesting`, `AuctionLauncher`,
`AppTokenLBPInitializer`, the hooks (`AllowlistHook`, `TrustGatedHook`; a DAO launch passes no hook), the LBAMM and
market contracts (evaluation only), `DaoURIAdapter`.

## 3. External dependencies

| Dependency | Pin | Used for | Trust |
|---|---|---|---|
| Uniswap continuous clearing auction | `lib/continuous-clearing-auction` `6c9e559` (factory v2.1.0 line, no tag); canonical factory `0x000000001F26a0044BaA66024e7b6599c61963F8` | The sale, clearing, refunds, claims, sweeps | Upstream code, audited by its authors; we rely on its accounting (bidders pay at most their limit, a failed sale refunds in full, sweeps only to the recipients it was created with). Our executor checks it is both recipients. |
| Permit2 | canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Bid payments | Standard deployment. |
| Majeur (Moloch) | `lib/majeur` `7d7a36b` (no tag) | The DAO the patch forks | Upstream, unaudited as far as we know: the patched copy is in scope in full, not only the patch blocks. |
| OpenZeppelin | the CCA's vendored copy (`lib/continuous-clearing-auction/lib/openzeppelin-contracts`) and `lib/openzeppelin-contracts` `08efabd` | `SafeERC20`, `IERC20`, `Math` | Standard. |
| Limit Break creator-token standards / transfer validator | `v5.0.0` / `59adb8b` | The ERC-20C surface of Shares (`setTransferValidator`) | Optional: zero until a DAO chooses a validator; never consulted on mint or burn, so it can never block an exit. |
| The sale currency (USDC) | per chain | Raise, treasury, bonds, deposits, claims | Assumed a plain ERC-20: no fee on transfer, no rebasing, no callbacks. The factory and `VerifierSet.bond` fail closed on short transfers; other paths do not check. A pausable or blocklisting USDC can freeze payouts to a blocked address (the exit, a bond release), not redirect them. |

Compiler: solc 0.8.37 for every first-party contract since D70 (before: 0.8.30, and 0.8.26 for the kit, the executor
and the allowlist hook), `via_ir`, optimizer 200 runs, EVM
`cancun` (the DAO uses transient storage for its reentrancy guard).

## 4. Who is trusted with what

- **The DAO (its holders, through a passed vote)** can spend the whole treasury, create and close work budgets, freeze
  claims, take reviewer bonds, forfeit (burn) a team member's locked tranches, change the voting lanes within bounds,
  award Shares for reviewed work within the year's allowance (and lower that allowance), and announce, open (30 days
  later) or relock trading. It can no longer turn ragequit off, open a share sale, grant allowances or permits, mint or
  hand out Shares outside an award, mint Loot, burn a holder's Shares, or install a lock guard after birth. That is the
  product's promise as [PILOT.md](PILOT.md) states it: a holder-governed treasury, with milestone-based unlocking of
  the team's allocation. Nothing protects raised money from a majority vote except the exit, which cannot be closed.
- **The team** votes with all its Shares from the first block (team Shares count in DAO votes, not in milestone
  votes). It cannot move or ragequit locked Shares, cannot take the lock guard off (set once), cannot vote on its own
  milestones, and cannot publish a milestone before the one before has stood and its month for late objections is
  over.
- **Reviewers** (work budgets and the panel lock) decide which claims are paid and, on the panel path, which milestones
  unlock. Their bond is at stake only through a DAO vote. A reviewer cannot judge their own claim, and a locked team
  member cannot sit on the panel.
- **The founder** chooses the launch terms once, within the kit's limits; after the launch transaction they have no
  special role. The kit and the factories hold no privileges after their call.
- **Anyone** can finish a milestone whose window passed, settle a vote, release a bond after the month, settle or expire
  a claim, execute a passed and queued proposal, return an expired budget's money to the DAO, and graduate a sale.

Known and accepted (the pilot says so to users): a team and its friends can buy in the sale and vote; a milestone
nobody objects to unlocks; one holder with most of the non-team weight decides every milestone vote; Shares still
unclaimed in the auction count in the eligible supply of a milestone vote; the last milestone is backed only by its
bond.

## 5. Invariants, and what holds each one

The Forge invariant suite (`contracts/test/invariant/MoneyPaths.t.sol`) drives a real summoned DAO with a challenge
lock, a work budget and bonded reviewers through random sequences (64 runs × 200 calls per invariant by default).
The simulation (`scripts/simulate-raise.mjs`) does the same on a real anvil chain through the full launch and sale,
with the web app's own encoders and exit/bid logic. Each invariant was also checked against a broken contract: the
"mutation" column is the guard removed, and in every case a test failed.

| # | Invariant | Forge | Simulation | Mutation that a test caught |
|---|---|---|---|---|
| 1 | Nothing leaves the treasury except through a holder's own exit or a proposal that met its bars (quorum of voting supply, approval share, majority, review, unbroken hold, not expired, queued for the delay), checked independently of the governor's `state` | `invariant_no_money_moved_outside_its_rules` (`_govern`, `_passing`, `_checkMoney`, the attacker) | every step (`checkInvariants`, `passing`) | governor executes without a passed vote; approval bar dropped |
| 2 | A locked Share never moves: a team member's balance never falls below `lockedOf`; a transfer, `transferFrom` or ragequit that would dip into it fails and one within the free part succeeds | `invariant_locked_shares_are_always_held`, handler checks | every step and every transfer and exit | lock guard ignored in `Shares` |
| 3 | Ragequit pays exactly what the web exit preview computes from the same reads (D51, D72): free Shares only, the DAO's own Shares and Loot and the lock's `totalLocked` out of the denominator, floor division | handler `ragequit`; `RagequitPreviewFfi.t.sol` runs the web's own TypeScript through ffi against the chain | every exit, through `fetchRagequitPosition` itself | D51 denominator patch removed; web preview ignoring the DAO's Shares; web preview offering locked Shares |
| 4 | While any milestone can still be objected to late (or has a vote open), no later milestone has been published; an upheld late objection burns exactly what is still locked, and for any milestone but the last that is more than nothing unless the DAO already forfeited it (D58) | `invariant_later_milestones_wait_while_an_earlier_can_be_objected_to`, handler `_resolve` | every step and every resolve | D58 month guard removed; clawback removed |
| 5 | A milestone vote counts the Shares the voter owned just before the objection, capped by what they hold now; the team cannot object or vote (D57) | handler `_object`/`_vote`, including Shares passed to another wallet after the objection | every objection vote | weight not capped by the current balance |
| 6 | A reviewer's bond is taken only by a passed vote, never beyond what they hold (stake first, then bond waiting to be taken back), and what is taken reaches the DAO | `governSlash`, `BondSlashFuzz.t.sol` | every step | slash open to anyone; slash paying more than it took |
| 7 | Custody: the lock holds exactly its unpaid bonds, the deposits of open objections and what it owes blocked payees; the panel exactly every stake and pending unbond; the claim escrow exactly the stakes and reservations of claims in play | `invariant_lock_holds_exactly_bonds_and_open_deposits`, `invariant_panel_holds_exactly_the_bonds`, `invariant_claim_escrow_is_fully_backed` | lock and panel every step | — |
| 7a | Liveness: once a milestone vote has ended, anyone can settle it, whoever the currency's issuer blocks (D67) | handler `_resolve`, with an issuer that blocks and unblocks actors and sometimes the objector mid-vote | every resolve | settlement reverting again on a blocked payee |
| 8 | A payout is paid only for an approved claim, after its 7-day challenge window, exactly the claim plus the stake | handler `_payout` | — | challenge window ignored |
| 9 | A work budget's money leaves only to a claim it reserved for or back to the DAO, and is never over-allocated; a lapsed claim can always be expired, whoever the currency blocks (D68) | `_checkMoney`, `invariant_budget_and_vote_ledger_bounds`, handler `expireClaim` | budget creation counted against the vote | the escrow's pay-or-owe fallback undone |
| 10 | The voting ledger mirrors the Shares (`totalCapacity == totalSupply`); no Shares are minted after the sale outside a vote, and burns happen only on exits, forfeits and upheld late objections; Shares waiting in the auction are outside the voting supply (D69) | `invariant_budget_and_vote_ledger_bounds`; `DaoLaunchKit.t.sol` | every step | the kit's auction exclusion removed |
| 11 | The sale: bidders on a met raise paid exactly what the DAO received (plus dust left in the auction), nobody paid above their limit; every bid on a missed raise is refunded in full and the DAO receives nothing | — (the CCA is exercised on a real chain) | after every sale | — |
| 12 | A tranche is freed only by a milestone that stood, and is never both freed and forfeited | `invariant_tranches_free_only_with_their_milestone` | — | — |
| 13 | The lock's `totalLocked` is always exactly the sum of its members' `lockedOf` (D72) | `invariant_locked_total_is_what_each_member_has_locked` | — | counter not lowered on a stand; not lowered on a forfeit; not lowered on a panel unlock |
| 14 | Under the issuance rule no Share or Loot appears outside an award, and no passed vote can mint, hand out the DAO's own Shares, mint Loot or burn a holder's Shares (D73, D76) | `invariant_no_shares_or_loot_appear_outside_an_award`, handler `governShareMoves`; `IssuanceRule.t.sol`, `ExitProtections.t.sol` | every launch is born with the rule | the award-only check removed; the count removed; the hand-out check removed; Loot's closure removed; the leaving-only burn removed |
| 15 | An award never takes the year's new Shares past the cap of that year's exit base; the cap only goes down (D76) | `IssuanceRule.t.sol` (with a stand-in DAO that says when an award is under way) | — | the count removed |
| 16 | While transfers are locked, Shares move only to or from the exempt address (the auction), and unlocking runs only 30 days or more after an announcement still standing (D77) | `TransferLock.t.sol` (a fuzz test over senders, receivers and amounts) | every transfer step expects the refusal | the notice check removed; the exemption widened |
| 17 | The kits refuse terms outside the limits, a team seat that is a system address, and (contributor projects) a founder stake above a third of the first budget or a founder on its panel (D74, D75, D79) | `DaoLaunchKit.t.sol`, `ContributorKit.t.sol` | every launch is inside them | each of the ten kit checks removed |

The mutation run is reproducible (`scripts/contracts-mutation-check.mjs`, 35 guards, all caught on 2026-10-21).

## 6. Observations made while preparing (no behaviour changed)

None of these is a loss of funds or a broken promise; each is worth an auditor's opinion.

1. `VerifierSet`: bond a reviewer asked back stays slashable after `availableAt` until they actually withdraw it; the
   doc comment says "until". A later `requestUnbond` also restarts the 14-day wait for everything already pending.
   Both favour the DAO.
2. `ClaimStake.submitClaimWithSchedule` exists on every work budget's escrow, but no `TreasuryMandate` wires a
   `RoyaltyDistributor`: such a claim can never settle to Approved (the mint call reverts) and only lapses after 30
   days. It harms only the contributor who files it; the web app never files one.
3. The implementation contracts (`AllocationVoting`, `Shares`, `Loot`, `Badges` behind the clones) can be initialized
   by anyone. Their own storage is never used by a DAO; confirm nothing reads it.
4. (Resolved by D76, 2026-10-21.) The patched Majeur kept `setAllowance`/`spendAllowance`, `setPermit`/`spendPermit` and
   `setSale`/`buyShares`, vote-granted paths out of (or dilution of) the treasury that the app never used. They are
   removed, with `setRagequittable` (D73); the upstream text stays in comments for the fork checker.
5. `MilestoneChallenge.eligibleSupply` reads current balances at the moment of the objection while weights use the
   block before; a holder who moves Shares into the team's or the DAO's wallets just before an objection lowers the
   3% bar slightly. Within the accepted "friends of the team" limitation.
6. `GraduationExecutor` in a DAO launch has `reserveBps = 0`: `releaseReserve` and `withdrawStuckReserve` are
   unreachable there. The kit could use a smaller executor; not changed, since the desktop's embedded bytecode
   depends on it.
7. Development tooling, not contracts: an anvil left running for thousands of blocks writes gigabytes of state history
   to `~/.foundry/anvil/tmp` unless started with `--prune-history`. The simulation does that; the older journey
   scripts do not, and 25 GB of such state from earlier runs was still on this machine.

## 7. Suggested focus for the auditors

1. The patched Majeur in full (it is unaudited upstream), especially `ragequit`, `executeByVotes` through
   `AllocationVoting`, `Shares._requireUnlocked`/`burnForfeited`, the clone and initialization order in `init`, and
   `multicall` with the transient-storage reentrancy guard.
2. `MilestoneChallenge`'s ordering rules (three reviews found ordering bugs by hand: D51, D57, D58) and its money
   (bond, deposit, bounty).
3. `AllocationVoting`'s snapshot, trim and queue-reset logic: the bars are frozen at opening, support can move until
   execution.
4. `DaoLaunchKit` address prediction and the "nothing half-configured" claim (every predicted address is re-checked
   after the summon).
5. The work-budget triangle (`TreasuryMandate`, `ClaimStake`, `VerifierSet`): funding, freeze/unwind, slashing,
   closing.
6. The tokenomics changes (D72–D79), which came after the ethskills walk in §10: the two transient flags in `Moloch`
   (`leaving` around the burns in `ragequit`, `awarding` around the mint in `awardContribution`) and the `Shares`/`Loot`
   checks that read them; the subtraction of `totalLocked` in `ragequit` (inside `unchecked`, guarded); the issuance
   year in `Shares._countIssued` and the award paid from the DAO's own holding first; the transfer exemption and the
   unlock notice; and the kit's terms check, including the reading of the floor and target from `auctionConfig` by
   offset.

## 8. How to rerun all of it

See [TEST-STEPS.md §4aj](TEST-STEPS.md). In short:

```bash
. ./bin/activate-hermit
cd contracts && forge test                                   # the whole suite, including the new invariants
cd contracts && forge test --match-path "test/invariant/*"   # only the money-path invariants and fuzz tests
scripts/simulate-raise.sh --steps 3000 --seed 7              # the agent-based simulation on its own anvil
node scripts/contracts-mutation-check.mjs                    # break each of 16 guards once; every one must be caught
```

## 9. What the simulation found

**Rerun on 2026-10-21 after the tokenomics changes (D72–D79): zero invariant breaks.** Seeds 7, 11 and 23, 3,000 steps
each, 9,000 invariant checks, every launch inside the kit's new limits (the whole tranche as the target, 60 / 25 / 15,
every team Share behind milestones). With transfers locked from birth, every transfer step between wallets was refused
by the lock (322 in the seed-23 run alone), and every exit paid what the web preview, now leaving out what the lock
still holds, said it would. The figures below are from the first runs, on the contracts before those changes.

**Zero invariant breaks.** Three runs of 3,000 steps each (seeds 7, 11 and 23, about 100 seconds each on a laptop),
9,000 invariant checks after individual steps plus a sale check after each of 35 sales. These are the runs on the
contracts after D67–D70 (solc 0.8.37, the currency's issuer blocking and unblocking people); the runs before them were
also clean, and with the same seeds the activity below is identical. After D69 the simulation's own independent vote
check at first flagged 43 executions: it still computed voting supply without the auction the launch now excludes. It
reads the policy's exclusion list now, and checks that every launch excludes its auction.

| What happened (all three runs) | Count |
|---|---|
| Projects launched through the kit (2 at the start of each run, then a fresh one whenever a schedule was settled) | 35 |
| Sales that met their target / missed it on purpose | 32 / 3 |
| Bids placed / refused by the auction (below the clearing price, or at its last block) | 1,482 / 342 |
| Bid exits and Share claims through the web's "Your bids and tokens" logic | 1,482 / 391 |
| Exits through the web's exit screen code (team members among them) / refused because locked / refused because the currency blocked the holder | 319 (43) / 2 / 61 |
| Share transfers / transfers into locked Shares refused | 872 / 62 |
| Proposals opened / allocations cast / executed (payments, work budgets, slashes, forfeits, and payments to the "attacker" that the holders voted for) | 388 / 7,971 / 43 |
| Milestones published / finished unchallenged / objections upheld before unlock / objections that failed | 78 / 29 / 22 / 25 |
| Late objections raised / upheld (each burned exactly what was still locked) / failed | 42 / 20 / 22 |
| Bonds released after the month | 20 |
| The currency's issuer blocking / unblocking a holder | 56 / 41 |
| Privileged calls tried by an outsider or a holder (all refused) | 335 |

What the sales showed every time: on a met raise, what the bidders paid equals what the DAO received plus the dust
the auction keeps (8 to 15 base units of USDC, a thousandth of a cent, and about 20 base units of Shares, from the
auction's own rounding), nobody paid above their own limit, and the bidders claimed 5,999,999.99… of the 6,000,000
Shares on sale. On the missed raise every bid came back in full and the DAO received nothing; the 6,000,000 Shares stay
in the auction until the DAO votes to recover them (`GraduationExecutor.recoverFailedLaunch` is the DAO's call only).

What the simulation reaches only thinly: work-budget claims (42 filed, 11 budgets created by a vote, no payout), which
the Forge invariants cover instead (`work.payout`, `govern.freeze`, `govern.unwind`, `govern.slash` in every run of
the handler); and the named-panel lock, which neither covers (its own 30-odd unit tests do).

What it found along the way, outside the contracts: the first runs filled the laptop's disk, because anvil keeps
every block's state on disk unless told not to (§6, item 7).

## 10. The ethskills audit checklists (2026-10-19)

Walked against the contracts in §2 with the method of [ethskills' audit skill](https://ethskills.com/audit/SKILL.md):
its master index, then the checklists its routing table picks for this code: general, precision math, ERC-20,
governance, access control, denial of service, assembly (CREATE2 clones, transient storage), proxies (clone
initializers) and signatures. The skill's own pipeline runs one sub-agent per checklist and files GitHub issues; here one
reviewer walked them all, and nothing was filed (the remote is public). Not applicable to this code: oracles, AMM (the
auction is upstream), lending, staking, ERC-4626, ERC-4337 (passkey wallets are outside the raise path), bridges,
flash loans (votes read ownership at the block before the proposal), ERC-721 (the badges are soulbound with no
callbacks), chain-specific (Sepolia only; on a rollup, `block.number` drives the sale, the claim block and every
snapshot, which needs its own review). Severity uses the skill's definitions.

## [ES-1] A blocked objector stalled the settlement of a milestone vote for good (fixed, D67)
**Severity**: High (permanent DoS under a precondition), fixed
**Category**: evm-audit-erc20 (blocklists), evm-audit-dos (blocklisted recipient)
**Location**: `MilestoneChallenge.resolve()`
**Description**: `resolve` paid the objector (deposit plus half the bond) and the DAO inside the call that settles the
vote. A USDC-style currency reverts transfers to a blocked address.
**Proof of Concept**: an objection is upheld; the issuer blocks the objector before anyone calls `resolve`; every
`resolve` reverts; `objection.open` stays true; `submit` of the next milestone reverts `EarlierStillOpen` forever; the
bond and deposit never leave the lock; an upheld late objection never burns. Reproduced on the old contract by
`test/MilestoneChallengeBlocklist.t.sol` (both tests reverted with "blocked").
**Recommendation (done)**: a refused payment out of `resolve` is credited to `owed[payee]` and the settlement goes on;
`withdrawOwed()` pays it to `msg.sender` only. The invariants now include a blocking issuer and a liveness check.

## [ES-2] A blocked contributor can strand a claim's reserve (fixed, D68)
**Severity**: Medium (owner-only fund loss), fixed
**Category**: evm-audit-erc20, evm-audit-dos
**Location**: `ClaimStake.expire()`, `ClaimStake.resolveFrozen()`
**Description**: both return the reserve to the budget and the stake to the contributor in one call. If the contributor
is blocked, both revert, so the reserve for that claim cannot go back to the budget (and on to the DAO).
**Proof of Concept**: a funded claim; the contributor is blocked; the claim lapses, `expire` reverts; the DAO freezes it,
`resolveFrozen` reverts.
**Recommendation (done, D68)**: the same pay-or-owe pattern as D67. `TreasuryMandateFactory` was 261 bytes under the
size limit because it embedded `ClaimStake` and `VerifierSet` through `TreasuryMandate`; a new `MandatePartsFactory`
makes them, and the factory is now 11,507 bytes. `test/ClaimStakeCurrency.t.sol` failed on the old escrow.

## [ES-3] Unclaimed sale Shares count in the DAO's voting supply (fixed, D69)
**Severity**: Low, fixed
**Category**: evm-audit-governance (quorum based on a supply nobody can vote)
**Location**: `AllocationVoting._votingSupply()`; `DaoLaunchKit` (no exclusion of the auction)
**Description**: Shares bought in the sale stay in the auction until each bid is exited and claimed. They are neither the
DAO's nor excluded, so they raise every quorum (20% of voting supply in the full lane) without being able to vote.
**Proof of Concept**: a sale where most buyers have not claimed: the first proposals need more turnout from the buyers who
have claimed than the lane's 20% suggests.
**Recommendation**: `exitBid` and `claimTokens` on the auction are callable by anyone (tokens always go to the bid's
owner), so a keeper could claim every bid at the claim block. Done instead (D69): the kit predicts the auction's address
and adds it to the policy's exclusions in the DAO's initialization, and requires the auction to land there.

## [ES-4] `ClaimStake` expects a `bool` from `transfer` (fixed, D68)
**Severity**: Low, fixed
**Category**: evm-audit-erc20 (missing return values)
**Location**: `ClaimStake` (`IERC20Minimal`)
**Description**: every other contract uses `SafeERC20` or Solady-style helpers; `ClaimStake` decodes a `bool`. A currency
whose `transfer` returns nothing (USDT on Ethereum) would make every stake, reserve and payout revert.
**Recommendation (done, D68)**: `SafeERC20`, now that the factory has room (see ES-2).

## [ES-5] The pinned compilers carry known bugs (fixed, D70)
**Severity**: Low, fixed
**Category**: evm-audit-general (compiler version)
**Location**: solc 0.8.26 (kit, executor, allowlist hook) and 0.8.30 (everything else), `via_ir`, optimizer on
**Description**: the Solidity bug list names, for these versions, `YulOptimizerKnowledgeBaseStaleBookkeeping` (applies:
the optimizer is on), the two stack-spill bugs in mutual recursion (via-IR; we did not search the code exhaustively for
mutual recursion), and others whose conditions this code does not meet (no `transient` state variables, no
named-argument custom errors in `require`, no custom storage layout). (A first version of this note said "fixed by
0.8.38": that came from the Solidity development branch's bug list; 0.8.38 is not released.)
**Recommendation (done, D70)**: every first-party contract now compiles with solc 0.8.37 (released 2026-09-10), whose
only listed bug is `YulOptimizerKnowledgeBaseStaleBookkeeping` (low; fixed in 0.8.38: move the pin when it ships). The
upstream auction keeps its own 0.8.26. Rerun the suite, the simulation and
the mutation check.

## [ES-6] Abstentions count toward quorum and not toward approval
**Severity**: Info
**Category**: evm-audit-governance (quorum excluding abstentions)
**Location**: `AllocationVoting.thresholdsMet()`
**Description**: with `minYesVotesAbsolute` at its default of zero, a proposal can reach quorum on abstentions and pass
with a small "for" if nobody opposes. Opposition is free (it never draws on a holder's pool), and the review, hold and
delay give at least 72 hours to oppose or leave (the hold runs inside the review; corrected 2026-10-21, it said 84).
**Recommendation**: a non-zero `minYes` per lane, or a product decision that this is acceptable.

## [ES-7] The proposal threshold reads current, not snapshot, ownership
**Severity**: Info
**Category**: evm-audit-governance (flash loan plus proposal creation)
**Location**: `Moloch._openAllocationProposal()`
**Description**: opening checks `policy.capacity(owner)` now; borrowed Shares could open a proposal. Voting on it uses
the snapshot, so this only allows opening. The launch default threshold is zero anyway.

## [ES-8] Other items checked and holding
**Severity**: Info
- Splitting an exit into several ragequits never pays more than one exit of the same Shares (each floor is at most the
  exact share of what is left; the sum is at most the floor of the whole).
- `multicall` is not payable, so `msg.value` cannot be reused across its delegatecalls; `nonReentrant` (transient
  storage) is cleared after each call.
- Calls to user-supplied tokens in `ragequit` tolerate addresses with no code (`balanceOfThis` reads zero; the transfer
  helper checks code); the token list must be strictly ascending, so no token is paid twice.
- Majeur's top-256 badge seats update on every Shares balance change; bounded (at most 256 slots read).
- The clones are not upgradeable; the implementations (`Shares`, `Loot`, `Badges`, `AllocationVoting`) can be
  initialized by anyone, which touches only their own unused storage (§6, item 3).
- `TreasuryMandate.close()` transfers even a zero balance back; a currency that reverts on zero transfers would block
  closing an empty budget (USDC does not).
