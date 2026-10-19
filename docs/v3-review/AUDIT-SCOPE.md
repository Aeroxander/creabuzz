# Audit scope: the milestone-locked raise

Status: prepared 2026-10-19 on branch `audit-groundwork` (from `v4-governance-rework` at `e72c8911b`). Nothing in
`contracts/src` changed while preparing it: the invariant tests, fuzz tests and the simulation found no bug to fix.
This is the groundwork for the external audit the roadmap requires before any raise goes live
([SOCIAL-MVP-ROADMAP-2026-10-19.md §5](SOCIAL-MVP-ROADMAP-2026-10-19.md)). Mainnet stays off until that audit is done
and its report replaces the "unaudited" notice.

**Freeze before sending.** Tag the commit the auditors receive and pin it here. A change to any file in the table below
after the tag needs either a re-review of that file or a written reason why it is outside the money paths.

## 1. What a raise does, end to end

1. **Launch, one transaction.** A founder calls `DaoLaunchKit.launchChallenged` (milestones judged by holders, the
   default) or `DaoLaunchKit.launch` (a named reviewer panel). In that one call the kit:
   deploys a `GraduationExecutor` it runs (CREATE2 from the founder and the salt); summons the DAO through the patched
   Majeur `Summoner` with the team, the executor (the sale tranche) and the kit (the DAO's own allocation, passed on at
   once) as its only holders; in the DAO's own initialization points the Shares at the milestone lock
   (`MilestoneChallenge` or `MilestoneLock`), names the review panel (panel launches only) and holds governance closed
   until the sale's claim block; points the executor's payee at the DAO; and creates, binds and funds the auction on
   Uniswap's canonical continuous clearing auction (CCA) factory.
2. **Sale.** Backers bid on the CCA through Permit2. When the sale ends anyone calls
   `GraduationExecutor.executeGraduation`: a raise that met its target is swept into the DAO's treasury and unsold
   Shares go to the DAO; one that missed it refunds every bid in full from the auction (`exitBid`), and only the DAO
   can recover the unsold tranche.
3. **After the sale.** Buyers claim their Shares from the auction. From the claim block on, holders govern the treasury
   with `AllocationVoting` (the only ballot): payments, reviewed work budgets (`TreasuryMandate` with `ClaimStake` and
   bonded reviewers in `VerifierSet`), freezing and unwinding claims, taking a reviewer's bond, forfeiting a departed
   founder's tranches. Any holder can leave with their share of the treasury (`ragequit`) while leaving is on.
4. **Milestones.** The team's Shares vote from the first block but the milestone-tied part cannot be moved or ragequit
   until its milestone stands: unchallenged after a public window, or confirmed by a holder vote that excludes the team
   (`MilestoneChallenge`), or approved by the named panel after a seven-day challenge window (`MilestoneLock`). A late
   objection within a month can burn every tranche still locked.

## 2. Contracts in scope

Lines are total and source lines (no blanks or comments) at `e72c8911b`.

| Contract | File | Lines (source) | Role in the raise |
|---|---|---|---|
| `DaoLaunchKit` | `src/DaoLaunchKit.sol` | 436 (314) | The one-transaction launch: executor, DAO, lock, panel, auction. Compiled with solc 0.8.26 (the CCA's pin). |
| `GraduationExecutor` | `src/GraduationExecutor.sol` | 459 (255) | Holds the sale tranche, funds the auction, sweeps the raise to the DAO, recovers a failed sale for the DAO. The kit uses it with `reserveBps = 0`, so its reserve paths are unused in a DAO launch. 0.8.26. |
| CCA interfaces | `src/CCA.sol` | 66 (30) | Mirrored interfaces of the upstream auction; `test/PinnedInterfaces.t.sol` compares them with the pinned source. |
| Patched Majeur DAO | `src/majeur/MolochPatched.sol` (`Moloch`, `Shares`, `Loot`, `Badges`, `Summoner`) | 2,641 (1,636) | The DAO, its treasury, ragequit, the Shares ERC-20(C) with the lock guard. Upstream is `lib/majeur/src/Moloch.sol`; the fork is additive: 64 `@@CREABUZZ PATCH` blocks, 314 lines inside them, upstream text kept in comments (`scripts/check-majeur-fork.mjs` enforces it). The runtime size is within 47 bytes of the 24,576-byte limit. |
| `AllocationVoting` (+ `IVotingWeight`) | `src/AllocationVoting.sol`, `src/VotingWeight.sol` | 629 (465) + 21 (13) | The only ballot: snapshots of owned Shares, two lanes, quorum, approval, review, hold time, the governor's queue reset. Cloned per DAO. |
| `MilestoneChallenge` (+ factory) | `src/MilestoneChallenge.sol`, `src/MilestoneChallengeFactory.sol` | 520 (401) + 30 (21) | The default lock: publish with a bond, object with a deposit, holder vote without the team, late objection burns what is still locked, milestones in order and only after the month on the one before (D56–D58). |
| `MilestoneLock` (+ factory) | `src/MilestoneLock.sol`, `src/MilestoneLockFactory.sol` | 199 (133) + 30 (20) | The panel lock: a tranche unlocks on a `Paid` claim in the DAO's named panel mandate. |
| `MilestoneBadge` | `src/MilestoneBadge.sol` | 118 (85) | Soulbound record minted on unlock. Moves no value. |
| `TreasuryMandate` (+ factory) | `src/TreasuryMandate.sol` | 416 (314) | Work budgets: a DAO-approved, finite budget in currency and/or Shares; projects; claim binding; reviewer slashing; closing. The factory is also where the panel is named. |
| `ClaimStake` | `src/ClaimStake.sol` | 444 (279) | Claim escrow: contributor stake, reserved payout, approval quorum, 7-day challenge window, freeze, unwind, expiry. |
| `VerifierSet` | `src/VerifierSet.sol` | 246 (166) | Reviewers, quorum, recusal, bonds with a 14-day unbonding delay, slashing by the owner (the mandate). |

About 4,100 source lines of first-party code, of which the patched Majeur is the largest piece.

**Adjacent, not in the raise path** (review if time allows; they share contracts above): `ContributorKit` (contributor
projects, no sale, D66), `OrgBinding`, `OrgAllowance`, `RoyaltyDistributor` (only reached through
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

Compiler: solc 0.8.30 (0.8.26 for the kit, the executor and the allowlist hook), `via_ir`, optimizer 200 runs, EVM
`cancun` (the DAO uses transient storage for its reentrancy guard).

## 4. Who is trusted with what

- **The DAO (its holders, through a passed vote)** can spend the whole treasury, create and close work budgets, freeze
  claims, take reviewer bonds, forfeit (burn) a team member's locked tranches, change the voting lanes within bounds,
  open a Majeur-native share sale, grant allowances and permits, and turn ragequit off. That is the product's promise
  as [PILOT.md](PILOT.md) states it: a holder-governed treasury, with milestone-based unlocking of the team's
  allocation. Nothing protects raised money from a majority vote except the exit while it is on.
- **The team** votes with all its Shares from the first block (team Shares count in DAO votes, not in milestone
  votes). It cannot move or ragequit locked Shares, cannot take the lock guard off (set once), cannot vote on its own
  milestones, and cannot publish a milestone before the one before has stood and its month for late objections is
  over.
- **Reviewers** (work budgets and the panel lock) decide which claims are paid and, on the panel path, which milestones
  unlock. Their bond is at stake only through a DAO vote. A reviewer cannot judge their own claim, and a locked team
  member cannot sit on the panel.
- **The founder** chooses the launch terms once; after the launch transaction they have no special role. The kit and
  the factories hold no privileges after their call.
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
| 3 | Ragequit pays exactly what the web exit preview computes from the same reads (D51): free Shares only, the DAO's own Shares and Loot out of the denominator, floor division | handler `ragequit`; `RagequitPreviewFfi.t.sol` runs the web's own TypeScript through ffi against the chain | every exit, through `fetchRagequitPosition` itself | D51 denominator patch removed; web preview ignoring the DAO's Shares; web preview offering locked Shares |
| 4 | While any milestone can still be objected to late (or has a vote open), no later milestone has been published; an upheld late objection burns exactly what is still locked, and for any milestone but the last that is more than nothing unless the DAO already forfeited it (D58) | `invariant_later_milestones_wait_while_an_earlier_can_be_objected_to`, handler `_resolve` | every step and every resolve | D58 month guard removed; clawback removed |
| 5 | A milestone vote counts the Shares the voter owned just before the objection, capped by what they hold now; the team cannot object or vote (D57) | handler `_object`/`_vote`, including Shares passed to another wallet after the objection | every objection vote | weight not capped by the current balance |
| 6 | A reviewer's bond is taken only by a passed vote, never beyond what they hold (stake first, then bond waiting to be taken back), and what is taken reaches the DAO | `governSlash`, `BondSlashFuzz.t.sol` | every step | slash open to anyone; slash paying more than it took |
| 7 | Custody: the lock holds exactly its unpaid bonds and the deposits of open objections; the panel exactly every stake and pending unbond; the claim escrow exactly the stakes and reservations of claims in play | `invariant_lock_holds_exactly_bonds_and_open_deposits`, `invariant_panel_holds_exactly_the_bonds`, `invariant_claim_escrow_is_fully_backed` | lock and panel every step | — |
| 8 | A payout is paid only for an approved claim, after its 7-day challenge window, exactly the claim plus the stake | handler `_payout` | — | challenge window ignored |
| 9 | A work budget's money leaves only to a claim it reserved for or back to the DAO, and is never over-allocated | `_checkMoney`, `invariant_budget_and_vote_ledger_bounds` | budget creation counted against the vote | — |
| 10 | The voting ledger mirrors the Shares (`totalCapacity == totalSupply`); no Shares are minted after the sale outside a vote, and burns happen only on exits, forfeits and upheld late objections | `invariant_budget_and_vote_ledger_bounds` | every step | — |
| 11 | The sale: bidders on a met raise paid exactly what the DAO received (plus dust left in the auction), nobody paid above their limit; every bid on a missed raise is refunded in full and the DAO receives nothing | — (the CCA is exercised on a real chain) | after every sale | — |
| 12 | A tranche is freed only by a milestone that stood, and is never both freed and forfeited | `invariant_tranches_free_only_with_their_milestone` | — | — |

The mutation run is reproducible: the list of guards and their replacements is in §8.

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
4. The patched Majeur keeps `setAllowance`/`spendAllowance`, `setPermit`/`spendPermit` and `setSale`/`buyShares`.
   All are `onlyDAO` to enable, so they are vote-granted paths out of (or dilution of) the treasury, consistent with
   invariant 1, but the web app shows none of them as decisions. An auditor may prefer them disabled like futarchy.
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

## 8. How to rerun all of it

See [TEST-STEPS.md §4aj](TEST-STEPS.md). In short:

```bash
. ./bin/activate-hermit
cd contracts && forge test                                   # the whole suite, including the new invariants
cd contracts && forge test --match-path "test/invariant/*"   # only the money-path invariants and fuzz tests
scripts/simulate-raise.sh --steps 3000 --seed 7              # the agent-based simulation on its own anvil
node scripts/contracts-mutation-check.mjs                    # break each guard once; every one must be caught
```

## 9. What the simulation found

**Zero invariant breaks.** Three runs of 3,000 steps each (seeds 7, 11 and 23, about 90 seconds each on a laptop),
9,000 invariant checks after individual steps plus a sale check after each of 35 sales:

| What happened (all three runs) | Count |
|---|---|
| Projects launched through the kit (2 at the start of each run, then a fresh one whenever a schedule was settled) | 35 |
| Sales that met their target / missed it on purpose | 32 / 3 |
| Bids placed / refused by the auction (below the clearing price, or at its last block) | 1,536 / 392 |
| Bid exits and Share claims through the web's "Your bids and tokens" logic | 1,536 / 434 |
| Exits through the web's exit screen code (team members among them) / exits into locked Shares refused | 383 (42) / 2 |
| Share transfers / transfers into locked Shares refused | 890 / 66 |
| Proposals opened / allocations cast / executed (payments, work budgets, forfeits, payments to the "attacker" that the holders voted for) | 373 / 8,084 / 43 |
| Milestones published / finished unchallenged / objections upheld before unlock / objections that failed | 91 / 26 / 29 / 36 |
| Late objections raised / upheld (each burned exactly what was still locked) / failed | 47 / 18 / 29 |
| Bonds released after the month | 30 |
| Privileged calls tried by an outsider or a holder (all refused) | 384 |

What the sales showed every time: on a met raise, what the bidders paid equals what the DAO received plus the dust
the auction keeps (8 to 15 base units of USDC, a thousandth of a cent, and about 20 base units of Shares, from the
auction's own rounding), nobody paid above their own limit, and the bidders claimed 5,999,999.99… of the 6,000,000
Shares on sale. On the missed raise every bid came back in full and the DAO received nothing; the 6,000,000 Shares stay
in the auction until the DAO votes to recover them (`GraduationExecutor.recoverFailedLaunch` is the DAO's call only).

What the simulation reaches only thinly: work-budget claims (13 filed, 8 budgets created by a vote, no payout), which
the Forge invariants cover instead (`work.payout`, `govern.freeze`, `govern.unwind`, `govern.slash` in every run of
the handler); and the named-panel lock, which neither covers (its own 30-odd unit tests do).

What it found along the way, outside the contracts: the first runs filled the laptop's disk, because anvil keeps
every block's state on disk unless told not to (§6, item 7).
