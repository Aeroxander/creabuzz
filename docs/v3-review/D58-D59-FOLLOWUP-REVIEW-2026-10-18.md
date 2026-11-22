# Follow-up review: D58 and D59 — 18 October 2026

> **History (review record), 2026-10-31.** Its findings were acted on at the time. The current index is [STATUS.md](STATUS.md).

Reviewed `c7342e0df..494b84180`, the AI handoff, and the working tree. App and contract sources were left unchanged. Existing uncommitted implementation work was preserved. This review follows up the previous findings and checks the new overview behavior against the user's selected Project first direction and the full DAO OS goal.

## One new finding

**[P2] A claim about to lapse is presented as something that can wait indefinitely.** In `web/src/features/launchpad/lib/dao-overview.ts:134–142`, a review item has no `due`, and the new consequence says “The claim stays open until enough reviewers have judged it.” `ClaimStake` records `expiresAt` when the claim is submitted and permits anyone to expire an unanswered Open claim after that time (`contracts/src/ClaimStake.sol:291–307`). Expiry closes the claim, returns the contributor's stake and sends the reserved payment back to the treasury; it does not pay the contributor for the work.

Reproduction through the production `attentionItems` helper: give a reviewer an Open, project-bound claim with one second left, and an Active decision with a day left. The vote comes first; the claim has no deadline and carries the indefinite-wait message. The existing `FinanceControls` contract tests independently confirm anyone can expire an abandoned claim and an expired claim cannot pay out. Those tests passed in this review's full Forge run.

Fix: carry `claim.record.expiresAt` into the review item's deadline and describe the actual consequence, for example: “After [date], anyone can close an unanswered claim. Its stake and reserved payment are returned.” After the deadline, distinguish “can now be expired” from an automatic state transition, since a transaction is required. Exercise ranking, the exact boundary and post-deadline handling through the production helper. This is a user-facing correctness finding, not a suggestion to change the financial mechanism.

Reproduction saved at `/private/tmp/creaton-d59-claim-queue-repro.mjs`; run with Node 24 using `node --experimental-strip-types /private/tmp/creaton-d59-claim-queue-repro.mjs`. Its assertions confirm the current defective ordering and message; they are a diagnostic reproduction, not a passing regression test for the desired behavior.

## The two previous findings are fixed

The contract now requires the previous milestone to have stood, its late-objection period to have elapsed, and no objection vote to remain open before the next milestone can be submitted. The new regression cases cover both a late vote that has ended but has not been settled and an objection opened in the last second of the period. These close the previously reproduced path in which the last tranche unlocked during an earlier late vote and left nothing to burn.

The reader now throws for empty, short, non-hex and impossible replies instead of treating missing words as zero. Independently rerunning the exact `readChallengeLock` reproduction with `call: async () => '0x'` now throws an unreadable-answer error, rather than returning null and selecting the panel interface. The broader core suite passes.

D59 also makes useful product progress: actions are ranked across the selected projects, deadline rows explain why they appear and what inaction means, an initial failed project read gets a named Retry affordance, unlocked milestones distinguish an unopposed attempt from a failed objection, and the treasury figure states that committed work money is excluded. Checking the attempt start avoids attributing an old rejected attempt's objection to a later unopposed retry.

## The new timing is a meaningful product choice

With a 30-day late-objection period and the 20/30/50 schedule used in the contract tests, the earliest unopposed unlocks are days **7, 51 and 102**, measured from the first publication. The final bond is held until day 132. This assumes evidence is immediately ready at every allowed publication time and someone finishes promptly; real delivery or objections can take longer. The guards add 60 days across this three-milestone schedule, compared with immediate sequential publication after unlocks.

The documentation's claim that this “costs a team little” assumes the next delivery takes at least a month. That will not hold for every team. Keep the simple guard for the pilot if retaining later tranches as collateral is the intended promise, but make the full earliest-release schedule visible before launch, rather than asking founders to infer it from prose. Public build logs and evidence drafts can continue during the wait; formal submission and unlock stay gated. Allowing overlapping submissions with separately gated releases would be a distinct protocol design, not a necessary fix in this review.

## D59 is partial delivery of the product request

The user selected **Project first**. A ranked action queue helps, but it does not yet connect the organization into one understandable project. The next slice should be a project overview that leads with its next delivery, linked tasks and blockers, accountable humans and agents, available versus committed money, and the actions that need the viewer. The user should be able to follow one delivery from task to output, review, milestone evidence, explicit payment claim and public progress update without reconstructing links across unrelated screens.

Task completion must remain separate from payment authorization. Keep relay tasks and onchain claims as separate linked records, reuse existing readers and event types, and preserve community access boundaries. An investor's public overview must not reveal private channels, agent prompts, credentials or sensitive output.

The handoff's stated dependencies are too broad:

- A progress feed of releases, evidence, accepted work, contributor credit and founder updates does **not** require a trading venue or price provider. Verified market activity and financial P&L do.
- A task-to-claim link and an agent overview of owner, current task, authority, estimated cost, approval and recovery can proceed independently of market integrations. Unknown costs should remain unknown; this browser's agent usage must not become a DAO-wide total.
- Dirty shell files call for careful integration and preserving the user's edits. They do not make the whole project overview dependent on a navigation rewrite. A shared project-context component can be built before global navigation changes.

For enjoyment, make completed work visible and social: named builders, useful outputs, demo/release cards, reactions and a weekly build recap. This creates reasons to return while the financial safety windows run. Avoid earning engagement by encouraging unnecessary transactions or by implying that an unopposed unlock is independent verification. Contribution credit and badges must not become voting weight.

The existing founder Manage screenshot is still a long stack of setup guidance, status, expert tools and launch configuration. Optional simplification: show one current next step and a compact launch checklist, then progressively disclose expert controls. Do not remove work, fund or agent management to achieve a shorter page.

The inspected 390px holder screenshot makes the same hierarchy problem concrete: nine project destinations wrap across three rows, and a long explanation of the protocol appears before the actual voting card. Keep one short current-state summary above the evidence and action; put the full explanation behind “How milestone unlocks work.” For example: “Milestone 1 is under objection. Vote by [date]. Your eligible weight: [amount].” Show the objection deposit and effect beside the relevant action and in its confirmation. After a raise closes, reduce the decorative cover and historical raise summary so delivery and decisions appear earlier. These are optional product improvements, not new contract findings.

The Home screenshot also places the full Get started checklist ahead of a founder's actionable milestone. Once a person has active project responsibilities, move urgent actions ahead of onboarding and collapse the checklist. The queue can be correct and still receive too little visual priority.

## Trust assumptions in the reviewed changes

The chosen default remains holder challenges with contract-enforced sequencing and permissionless finish/resolve calls. The reviewed lock source is available under MIT; the repository's root license is Apache-2.0. This is source evidence, not verification of a production deployment or every dependency's licensing. The UI supports configurable RPC endpoints, so a failed provider need not be permanent, although public evidence and coordination still depend on relay availability.

Accepted mechanism tradeoffs remain holder-majority discretion, silence allowing an unlock, public onchain actions/evidence commitments, a bond rather than recoverable released Shares behind the final tranche, and the payment token's behavior and issuer controls. Milestone locks constrain the team's allocation; they do not turn the entire DAO treasury into milestone escrow or guarantee a refund. Preserve that distinction in the overview. Nothing in D58/D59 establishes production audit assurance.

## Independent validation

- Core: **764 passed**.
- Web: **1,718 passed**.
- Contracts: **397 passed, 2 optional fork tests skipped**.
- Production web typecheck/build passed; existing large-chunk warnings remain.
- Empty-lock-response reproduction now throws as required.
- The new claim-queue reproduction confirms the finding above.
- The unchanged checked-in challenge browser journey passed on its own disposable local chain: launch, bids, claim, rejected attempt, unopposed retry, Home failure/retry, blocked next submission during the late period, and an upheld late objection that burns the remaining locked Shares. Inspected its Home, founder Manage, desktop Milestones and 390px holder screenshots.

The handoff's claimed eleven-journey gate and full mocked-browser run have not been independently rerun in this review. The challenge journey uses real local contracts and wallet transactions with a mocked relay; it does not establish hosted onboarding or production readiness.

Review judgment for this increment: minimalism **9/10**, elegance **8/10** because work, agents and funding still lack a shared project context, and correctness **8/10** because the new queue misstates claim expiry. The concrete fixes are the shared project/task detail and accurate claim deadlines/consequences. These are review judgments, not security ratings.
