# The award follows approval: no separate finish step

Status: written and tested on `v4-governance-rework` on 2026-11-01. **Not deployed.** The owner lifted the contract
freeze (D137) for development only: the pilot keeps running against the deployed contracts, and this change ships only
after the pilot ends and an external audit has covered it ([AUDIT-SCOPE.md §12](AUDIT-SCOPE.md)). It answers decision 4
of the suite review ([SUITE-REVIEW-2026-11-01.md §8](SUITE-REVIEW-2026-11-01.md)).

## The problem

In a contributor project, earning Shares for a piece of work goes: file the claim, the manager accepts it, two
reviewers approve, someone settles the approval, the 7-day challenge window runs, and then the DAO votes the award.
Between the window and the award sat one more step. `TreasuryMandate.consumeContribution` (which the DAO's
`awardContribution` calls) accepted only a claim in state `Paid`, and only `ClaimStake.payout` moves a claim from
`Approved` to `Paid`, and only the claim's own contributor could call it. For a claim that asks for no money (the usual
case in a contributor project) that call moves nothing, yet until the contributor came back and pressed "Mark it
finished", the award vote could not pass. A contributor who did not know about the step, or was away, blocked their own
award, and the person running the project could not do it for them.

## The change

Two small changes, both outside the patched DAO (`MolochPatched.sol` is untouched; its size is unchanged).

1. **`ClaimStake.payout`: anyone may finish a claim that asks for no money.** The contributor-only check now applies only
   to a claim with a non-zero `amount`. Everything else in `payout` is as before: the claim must be `Approved`, its
   challenge window must have passed, and it becomes `Paid` once. Whatever stake the claim carries still goes only to
   the contributor; for such a claim it is returned through the same `_payOrOwe` that `expire` and `resolveFrozen` use,
   so a currency that refuses the contributor (a blocked USDC address) keeps the stake for them in `owed` instead of
   making the call fail.
2. **`TreasuryMandate.consumeContribution`: the award finishes such a claim itself.** It accepts a claim that is `Paid`
   (as before) or one that is still `Approved` and asks for no money; for the latter it records the award and then calls
   `claims.payout` in the same call. That call fails inside the challenge window, so the whole award fails with it. A
   claim that asks for money must still have been paid to its contributor first.

So for a Shares-only claim the award vote can be opened as soon as the claim is approved, and it executes once the
challenge window is over with nobody pressing anything in between. The contributor can still finish it themselves, and
so can anyone else, which changes nothing for them except the timing.

## What stays safe

| Property | Why it still holds |
|---|---|
| No award before the challenge window ends | The award calls `payout`, whose window check is unchanged; inside the window the award reverts with `InChallengeWindow`. |
| No award for a frozen, rejected, unwound or expired claim | `consumeContribution` accepts only `Paid` or `Approved`; `payout` also refuses anything not `Approved`. A freeze during the window still stops both. |
| No double award | `contributionAwarded` is set before the finishing call, and a finished claim is `Paid`, which `payout` refuses again. |
| Money claims unchanged | A claim with a non-zero `amount` is still paid only by its contributor's own call; the award still requires it to be `Paid`. |
| A stranger gains nothing by finishing someone's claim | Only the stake moves, and only to the contributor (or into their `owed`). |
| The escrow stays fully backed | A stake kept in `owed` is counted by the existing escrow invariant. |
| Reentrancy | The award writes its state (`sharesAwarded`, `contributionAwarded`, the event) before the external call to `payout`, and it is DAO-only. |

One consequence to know about: a milestone claim in a DAO's milestone panel also asks for no money, so anyone can now
move it to `Paid` after its window, which is what `MilestoneLock.unlock` waits for. Unlocking still needs the same
approved claim, the same words and the same passed window; it only no longer waits for the team member to press a button.

## Tests

`contracts/test/FinishStep.t.sol` (new; each test failed on the old code, except the three that pin behaviour that must
not change):

- the bounded-lane award vote, opened during the window, executes after it with no finish step, finishes the claim,
  and cannot be repeated (failed before: the vote could not execute);
- the award returns a Shares-only claim's stake to its contributor (failed before);
- no award inside the challenge window (failed before with the wrong reason; now `InChallengeWindow`);
- anyone may finish a Shares-only claim after its window, the stake goes to the contributor and nothing to the caller,
  and not before the window (failed before: `NotContributor`);
- a blocked contributor's stake waits in `owed` and the claim still finishes (failed before);
- no award for a frozen or unwound claim, none for a rejected claim, and a money claim still waits for its contributor
  (these three passed before and after: they pin what must not change).

`contracts/test/invariant/MoneyPathsHandler.sol`: the payout step now lets anyone try, and checks that a money claim is
never finished by someone else, that whoever finishes it is paid nothing, that the contributor gets exactly the claim and
stake (or it waits in `owed`), and that an approved claim asking no money can always be finished after its window. A
quarter of the generated work claims now ask for no money, so the new path is reached in every run
(`work.payoutByAnyone`).

Each guard was broken once by hand and a test failed each time: money claims finishable by anyone, the stake paid to
the caller, the award finishing money claims, the award skipping the finish, and the award accepting other states. The
whole contracts suite passes (593 tests). Sizes: `ClaimStake` 7,596 bytes, `TreasuryMandate` 7,423,
`TreasuryMandateFactory` 11,833, `MandatePartsFactory` 12,591, all far under the limit; `Moloch` unchanged at 23,999.

## Not done here

- Nothing is deployed and no address or manifest changed. Existing budgets keep the old rule forever (their
  `ClaimStake` and `TreasuryMandate` are fixed code); only budgets made by a factory deployed after the audit get it.
- The web app still asks for "Mark it finished". Once budgets with this change exist, the award form should list
  approved Shares-only claims whose window has passed, and the finish step can go from the contributor's list.
- `scripts/contracts-mutation-check.mjs` has no entries for the new guards yet (it refuses to run on uncommitted files);
  the five hand mutations above are the ones to add.
