# Does the raise's currency reserve apply? (outside review A 5.1, critique 3)

Written 2026-11-01. A reading of the code, not a change: no contract was touched, and LBAMM stays closed (D150, D151;
[LBAMM.md](LBAMM.md) is evaluation only).

**The claim (review A 5.1):** `GraduationExecutor.releaseReserve` can never be used, because no pool will ever record an
address; so either decide "rounds only, treasury vote as the fallback" or build LBAMM, and tell people where the reserve
can end up.

**The answer: it does not apply to any launch the web app can make today, and where it would apply, the contract
already has a fallback.** Not a blocker for the pilot (which has no raise at all, D137) or for the raise as built.

## What the code says

1. **The DAO launch kit builds its executor with a zero currency reserve.**
   `contracts/src/DaoLaunchKit.sol`, in `launch`: `new GraduationExecutor{salt: ...}(address(this), 0, 30 days)`. The
   second argument is `reserveBps`. In `GraduationExecutor.executeGraduation`, `reserveShare = received * reserveBps /
   10_000` is then 0, `reserveEscrow` is recorded as 0, and the whole raise (`treasuryShare = received`) is paid to the
   treasury in the same call. The kit points the treasury at the DAO before binding the auction
   (`exec.retargetTreasury(dao)`), so the raise lands in the DAO. **Confirmed.**
2. **`releaseReserve(auction, tokenMasterPool)` takes its destination from the treasury.** Nothing has to "record" a
   pool first: the treasury (here the DAO, so only by a passed vote) names the address in the call, and the reserve goes
   there once. It refuses a zero address, a second release, and an empty escrow (`NothingToRelease`). With a zero
   reserve it can only revert. **Confirmed;** the review's "no pool will ever record an address" misreads the call.
3. **`withdrawStuckReserve(auction)` is already the delayed treasury fallback.** It opens `reserveLockSeconds` after
   graduation (30 days for the kit's executor), only while no pool was named, and pays only the treasury. With a zero
   reserve it also reverts with `NothingToRelease`. **Confirmed.**
4. **Every executor the web app deploys is the kit's.** The pre-kit raise path (a hand-deployed executor with
   `DEFAULT_RESERVE_BPS = 4000` in `packages/creaton-core/src/launchpad/auctionPlan.ts`) was removed from the web app in
   D150; the desktop app keeps a copy and is not part of the MVP. Launches made by that older path on a test network
   still open read-only in the web app, and their Treasury panel shows any escrow they hold; their treasury can name a
   destination with `releaseReserve`, or take it back with `withdrawStuckReserve` after the lock.

## Two things not to mix up

- **The escrowed currency reserve** (`reserveBps`, `reserveEscrow`): part of the raise's money, held by the executor.
  Zero for every kit launch.
- **The DAO's own Shares allocation** (`daoShares` in the kit, at most 20%, rule 3 of `UnfairTerms`): Shares minted to
  the DAO itself, outside voting and outside exits. It is not money and has nothing to do with the executor. Some code
  comments call it "the DAO's reserve" (for example `contracts/test/DaoLaunchKit.t.sol`); copy people read should not.

## What would change this

A future launch path that passes a non-zero `reserveBps` to the executor would need, before it ships: copy saying where
the reserve can go (a destination the DAO votes for, or back to the treasury after the lock) and a pinned test of both
paths for that path's executor. Until then there is nothing to tell people, because there is no reserve.

**Suggested, outside this change** (contracts are another group's area): a one-line assertion in
`contracts/test/DaoLaunchKit.t.sol` that the kit's executor has `reserveBps() == 0` and that, after
`executeGraduation`, the DAO received the whole raise. Today nothing pins the zero, so a change to the kit's
constructor arguments would pass the suite.
