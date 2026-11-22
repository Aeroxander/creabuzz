# Creaton follow-up: optimistic milestones — 18 October 2026

> **History (review record), 2026-10-31.** Optimistic milestones belong to raises, which wait for the audit (D137). The current index is [STATUS.md](STATUS.md).

Reviewed `62e4adcaf..0b5ec8f72` and the current related Milestones-tab copy edit. The final commit landed during the review and records launch-default and pilot-document edits already present in the tested working tree. Existing staged and unrelated working-tree changes were preserved. This is a product and implementation review of the new mechanism, not a full security audit. The earlier plans are context; the new mechanism is judged on its own promises and consequences.

## Product assessment

The public milestone timeline, Overview summary, founder/backer onboarding, and Home reminders are substantial improvements. They bring the funding agreement into the normal user journey. The pilot documents now accurately separate the original team's locked allocation from the DAO's discretionary treasury.

The optimistic rule is a reasonable experiment: the team publishes evidence and posts a bond; its tokens unlock unless holders successfully challenge the claim. It removes the need to recruit a fixed panel and the risk that an unavailable panel permanently strands an honest team.

It also changes the product's protection. A token vote establishes holder consent, not independent proof of delivery. Silence can release tokens. This model depends on holders seeing evidence, noticing deadlines, being able to vote, and finding objection worthwhile. Those are operating requirements, not details to postpone until after the contract ships.

I would test this with an attentive testnet cohort after fixing the findings below. I would not describe it as stronger verification or carry forward the old named-reviewer promise into the default flow.

## Prior findings that are fixed

- The aggregate runner now gives its Anvil processes a private cache directory and deletes only that directory; it no longer infers ownership from global creation times or the absence of other running nodes.
- Its self-test retains the server PID it started and leaves an existing listener alone.
- Destructive form defaults are pinned rather than silently advancing to the next target.
- Bond precision is explicitly marked unknown; the earlier guessed-decimal slash path is guarded.
- A public Milestones tab and role-specific onboarding implement the main product recommendations from the last review.

## Concrete findings

### 1. [P1] Challenge voting can count delegated team votes and post-objection acquisitions

[MilestoneChallenge._weight:480](../../contracts/src/MilestoneChallenge.sol#L480) takes the smaller of historical delegated votes and current balance. Historical delegated votes are not historical ownership. A team member can delegate locked Shares to an outsider before the objection, and that outsider can fill the delegated capacity with Shares acquired afterward.

An isolated test using production contracts demonstrated: a team member delegates 100 Shares to a backer holding 10; another holder objects with 60; the delegate acquires another 50 after the snapshot and casts 60 accepting weight instead of its historical 10. The tie causes an unlock rather than an upheld objection. A second test transfers the same 60 Shares between two recipients of team delegations and obtains 140 rejecting weight against only 120.5 eligible Shares.

This violates the stated exclusion of delegated votes and post-objection purchases. Use historical owned Shares, capped by current ownership. [AllocationVoting.getPastCapacity:288](../../contracts/src/AllocationVoting.sol#L288) already exposes an ownership checkpoint. Add both outcome-changing regression cases.

### 2. [P1] The new challenge journey still kills by port without ownership

[web-challenge-e2e.sh:51](../../scripts/web-challenge-e2e.sh#L51) kills whatever uses its selected chain port. Its exit trap is installed before the occupied-preview check. If that port names another node and the preview port is occupied, the script exits before starting its own chain and then stops the unrelated node. A random port collision creates the same risk.

Track the actual Anvil PID this journey started and clean up only that process. The parent runner's process group does not constrain an explicit foreign-PID kill inside a child script. No destructive test against a foreign listener was run.

### 3. [P2] An already-open milestone screen does not follow votes or deadlines

[use-challenge-lock.ts:17](../../web/src/features/launchpad/use-challenge-lock.ts#L17) sets stale time but disables focus refresh and provides no polling or visible refresh. Only successful transactions in that browser invalidate the challenge queries. Stale time alone does not schedule a read.

A holder watching before another wallet objects does not receive the Vote action. A waiting screen does not become ready to finish when its deadline passes. Home uses the same query. Add bounded refresh with failure handling, a visible refresh/retry action, and updates at relevant deadlines. Exercise an untouched page while a different account objects and while chain time crosses the deadline; reloading between steps does not test this behavior.

### 4. [P2] An unreadable lock can become a different financial agreement

[readChallengeLock:303](../../packages/creaton-core/src/launchpad/milestoneChallenge.ts#L303) catches every failure of `milestoneCount()` and returns null. A direct reader reproduction returned null for an RPC 503. [MilestonesTab:89](../../web/src/features/launchpad/ui/MilestonesTab.tsx#L89) falls back to the panel reader, hiding the challenge's active state; the powers view can still render named-reviewer guarantees. Failed later reads also leave mode-dependent views without a reliable distinction between unknown and panel. The latest uncommitted Milestones-tab copy removes some panel-specific text when no panel is found, but does not fix the mode/read-state distinction.

Represent confirmed panel, challenge, loading and unreadable states separately. A confirmed missing method may identify an older panel; a transport failure does not. Show retry and retain uncertainty instead of substituting named-reviewer guarantees or hiding an active objection.

### 5. [P2] The main pitch still promises approval and sequential release

[HomeHero:69](../../web/src/features/feed/ui/HomeHero.tsx#L69) says named reviewers read and approve every milestone. Its main paragraph says delivery is judged. [MilestoneSummaryCard:34](../../web/src/features/launchpad/ui/MilestoneSummaryCard.tsx#L34) promises release one milestone at a time after evidence is judged.

The new default requires no affirmative approval and permits concurrent milestone submissions. These are purchase-relevant promises, not cosmetic wording. Make global copy describe both modes honestly, and show the selected rule on each project's agreement. Suggested default copy: **“The team publishes evidence and posts a bond. Its tokens unlock after the objection period unless holders successfully challenge the claim.”**

### 6. [P2] Changing wallet or launch can overwrite another evidence draft

[PublishForm:318](../../web/src/features/launchpad/ui/ChallengeMilestoneCard.tsx#L318) loads text only at mount, then saves that text whenever its lock/wallet/index key changes. Cards are keyed by milestone index. Switching between two team wallets can copy A's text into B's storage key and overwrite B's existing draft. Routing between challenge launches can retain the same component identity.

Remount or reset the draft by lock, wallet and milestone, and fence asynchronous completion to that identity. [The viewer query:50](../../web/src/features/launchpad/use-challenge-lock.ts#L50) also keeps a different wallet's weight and voted status as placeholder data; scope that data to the same lock and identity so a previous wallet cannot hide the current wallet's vote affordance.

### 7. [P2] The challenge evidence view loses read-failure and history-completeness states

[ChallengeMilestones:57](../../web/src/features/launchpad/ui/ChallengeMilestones.tsx#L57) does not pass evidence error, incomplete-history or retry through to the cards. [ChallengeMilestoneCard:182](../../web/src/features/launchpad/ui/ChallengeMilestoneCard.tsx#L182) instead tells holders no matching text was found and to treat the submission with suspicion.

A dropped relay read or a bounded history cutoff is not evidence that the team failed to publish. Restore separate missing, mismatched, unreadable and incomplete states, with Retry. This is a regression of the earlier evidence recovery work in the new default path.

### 8. [P2] Publish can start before the sale permits a submission

[challengeActions:110](../../web/src/features/launchpad/lib/challenge-copy.ts#L110) offers Publish to the team without checking the lock's earliest block. The action publishes evidence and can send a bond approval before [submit:297](../../contracts/src/MilestoneChallenge.sol#L297) inevitably reverts before the claim block.

Gate the complete action against a current chain block and state when submission opens. A contract revert prevents an invalid unlock but does not undo an earlier approval transaction or its gas cost.

## Design choices, not additional correctness blockers

**Late objections do not reclaim released tokens.** A production-contract reproduction submitted all three default tranches together, finished all on day 21, and upheld a late objection. It burned zero Shares because none remained locked. This follows the documented rule. Making the last tranche largest does not guarantee collateral while concurrent release is allowed. Either describe the protection as the bond plus whatever remains locked, or deliberately retain collateral until the earlier late-objection periods end. That would be an intentional economic change.

**Choose who watches before choosing more mechanisms.** For the pilot, recruit willing holders to inspect evidence and explain exactly what an objection risks and can receive. Home reminders help when people visit; they are not proof of continuing attention. Test whether people notice a milestone without being directed to it. The watcher role matters more now than another reputation score or AI check.

**Keep capital and compensation separate in the explanation.** Treasury spending remains governed by holders; this change controls the original team's token liquidity. The new pilot documents correctly state that boundary.

Optional corrections: display exact objection times and time zones; change the runbook's universal “a week” answer to the displayed deadline (large tranches and retries wait longer); show raw units for an external challenge lock's unknown bond precision. A standard pilot in the sale currency avoids that custom-token display path.

## Validation and readiness

Current independent checks: production web build passed; all 762 shared-core and 1,706 web tests passed with zero skips. The complete Foundry suite passed with required artifacts enabled. Four additional isolated production-contract tests demonstrated the voting failures and checked bond recovery and concurrent-release behavior. Their source is `/private/tmp/creabuzz-milestone-review-oct18/test/Review.t.sol`.

The runner self-test passed all 12 assertions with process/server discovery constrained to fixture-owned stand-ins. A native attempt safely left the existing preview listener alone and was blocked; it was not counted as a successful complete native run.

The real-chain browser journey passed: launch, two backers bidding/claiming, evidence and bond, upheld objection, retry with a longer window, unlock, and an upheld late objection burning the remaining allocation. It used a temporary isolated-port harness because another preview owns 4173. The checked-in fixture hardcodes that WebSocket port and still asserts the former panel default; the temporary copy corrects those test assumptions and bounds action waits, without changing application or contract code. This is not a claim that the unchanged checked-in journey passed. The relay was mocked and shared between the browser users; contract transactions were real on the private local chain, with clocks advanced by the test. The journey reloads between relevant external events and therefore does not close the freshness finding.

Before a hosted pilot, fix the findings, deploy the matching kit/factories, and verify passkey transactions, test-currency funding and account recovery on the actual stack. Then run independent people through submission, upheld objection/retry, unlock, paid-work dispute and exit. Local clocks advanced by tests do not establish real-time attention or hosted operation.

Review judgments: minimalism 8/10 (the pilot is narrower, but the new adjudication model adds another lifecycle to explain); elegance 8/10 (the timeline is coherent, but mode/freshness/error handling still breaks that coherence); correctness 7/10 (the demonstrated voting defect and recovery regressions need fixing). These are product/code-review judgments, not security assurance scores.
