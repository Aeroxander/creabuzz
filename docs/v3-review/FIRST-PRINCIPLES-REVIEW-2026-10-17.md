# Creaton: D54 review and a first-principles MVP — 17 October 2026

> **History (review record), 2026-10-31.** Its findings were acted on in the decisions that followed it (D55 onward); the MVP it proposed was replaced by contributor projects with no raise (D63, D137). The current index is [STATUS.md](STATUS.md).

Reviewed `38baf1258..62e4adcaf`, with the existing uncommitted work preserved. This follows the previous review's nine finding groups and checks material defects in their fixes. The product recommendations below deliberately treat the vision and decision documents as context, not requirements. No application or contract source was changed during this review.

## Assessment

The product is substantially more credible now. The useful proposition is an understandable funding agreement connected to the place where a team shows its work: people back a project, see the terms and progress, and judge whether the team earned the release of its locked allocation.

D54 improves failure handling, not just presentation. Exit waits for the sale currency; submission confirms its saved draft before sending; pending bond withdrawals remain visible and slashable; spending distinguishes missing information from zero; closing a budget discloses the loss of future Shares awards; evidence has bounded pagination and an incomplete-history state. Those are valuable changes.

I would finish the remaining defects, narrow the supported pilot, and get independent people through it. I would not add another token, scoring system or market mechanism before that.

## Remaining correctness findings

1. **[P1] Cleanup still deletes state without proving ownership.** [mvp-gate.sh:64](../../scripts/mvp-gate.sh#L64) deletes newly appearing global `anvil-state-*` directories when no Anvil is currently running. Another task can start and stop a fork during this run; its saved state is then deleted. Process-discovery errors are also converted into an empty result at [line 51](../../scripts/mvp-gate.sh#L51). An isolated fixture reproduced a successful gate that deleted another actor's newly created state. Remove global state cleanup, or give each run a private state directory and delete only its recorded paths. Time of creation and absence of a running process do not establish ownership.

2. **[P1] The new runner self-test can stop an unrelated server.** [test-mvp-gate.sh:61](../../scripts/test-mvp-gate.sh#L61) starts a server, then replaces its identity with whichever PID `lsof` finds on 4173 and kills that PID at [line 69](../../scripts/test-mvp-gate.sh#L69). If 4173 was occupied, the new server fails and the selected PID belongs to someone else. Retain the spawned child's `$!`, fail or skip on an occupied port, and verify the listener belongs to that child. Never register a discovered foreign PID for cleanup.

3. **[P2] Untouched defaults can still change destructive targets.** [resolvePick:30](../../web/src/features/launchpad/lib/claim-pick.ts#L30) chooses the first option while selection is empty. [CloseBudgetForm:194](../../web/src/features/launchpad/ui/enforcement-forms.tsx#L194) and [SlashForm:296](../../web/src/features/launchpad/ui/enforcement-forms.tsx#L296) leave selection empty until the dropdown is changed. If the displayed budget closes or reviewer withdraws during refresh, the next entry silently replaces it; an entered slash amount remains. Explicit selections and claim-specific requests are now protected. Require an explicit destructive target, or persist the initially displayed target. Exercise disappearance after entering an amount, without changing the dropdown first.

4. **[P2] Bond amounts still use guessed precision on a token metadata failure.** [readCurrency:143](../../packages/creaton-core/src/launchpad/workRead.ts#L143) defaults to 18 decimals; the changed [bond reader:202](../../packages/creaton-core/src/launchpad/workRead.ts#L202) presents those terms as readable. A production `readWork` reproduction with only USDC's `decimals()` failing returned `symbol: USDC`, `decimals: 18`, `minBond: 50000000`, and `bondUnreadable: false`. That misrepresents 50 USDC and gives the slash parser the wrong scale. Preserve raw balances and withdrawal, mark precision unknown, and stop quantity-sensitive actions until it is known. The new bond metadata test fails `bondToken()`, not the token's `decimals()`.

Optional display correction: the no-auction exit path resolves the record's token correctly, but [RagequitPanel:154](../../web/src/features/launchpad/ui/RagequitPanel.tsx#L154) fetches metadata from the disabled auction query's undefined result. Fetch it from the resolved exit token instead. Its current raw-unit fallback is conservative, but unnecessarily obscure.

## The financial promise to keep

The current mechanism makes the original team's tokens transferable only after approved milestones. The team already owns and votes with those locked Shares. Meanwhile, holders govern the treasury and can authorize direct spending or issue additional Shares. A lock on the original allocation therefore does not make all raised money conditional on delivery.

For this MVP, I recommend keeping that model and stating it plainly: **a holder-governed treasury, with milestone-based unlocking of the team's allocation.** Reviewed budgets should be the normal work-payment route; direct payments should remain visible as spending without delivery review.

If the desired promise is instead that specified capital cannot leave before delivery, a reserve outside discretionary treasury spending must enforce that restriction. Give the team an agreed operating budget and place the protected remainder behind explicit release conditions. That is a different contract architecture and tradeoff. Another disclosure card cannot provide it; the current pilot need not be delayed to build it if its narrower promise is acceptable.

## Product changes I would prioritize

**Make the public milestone timeline the main product.** Every visitor should see the agreed criterion, allocation affected, status, submitted evidence, reviewer decisions, challenge deadline and release. The current actionable tranche view is scoped to the connected team's wallet ([WorkTab:119](../../web/src/features/launchpad/ui/WorkTab.tsx#L119)); the same story needs a public read view before and after funding. Start from that agreement rather than requiring a backer to reconstruct it across Work, Decisions and the technical record.

**Give backers and founders different first steps.** Signed-in onboarding still treats creating a project and running an AI helper as required progress, while following and fundraising are optional ([HomeHero:156](../../web/src/features/feed/ui/HomeHero.tsx#L156)). A backer should discover a project, inspect its terms, back it and follow progress. A founder should publish a project and define its funding agreement. AI helpers and the broader workspace can stay available without being everyone's activation checklist. This intentionally departs from the workspace-first emphasis of the vision documents.

**Make the funding agreement concrete.** Before bidding, show ownership and voting control after the sale, the team's locked and free allocation, reviewer identities and conflicts, capital spending authority, and the conditions of exit. A supply split alone does not explain who can pass a decision. Keep those facts prominent and protocol checks folded away, as the recent page changes already start to do.

**Operate the reviewer system before extending it.** Reviewers need to accept the role, understand the criteria, know their response expectations and compensation, and understand when their bond can be taken. A fixed panel prevents friendly replacement but can strand an honest team if quorum disappears. For a short pilot, disclose and accept that commitment with willing reviewers. For longer projects, evaluate a backup panel agreed before funding; avoid unrestricted replacement by an interested majority. This is an operating/design choice, not a newly discovered D54 bug.

**Keep reputation as inspectable history.** Show completed and missed milestones, reviewer reversals, spending routes and founder history. Those records can help someone decide without introducing a composite trust score or claiming that an onchain event proves fraudulent intent.

## What belongs in the pilot

Support one network, USDC and one own-DAO launch format. Keep discovery/following, project updates, clear sale terms, bids/refunds/token collection, public milestones, evidence review, disputes, budget recovery, spending visibility and exit. Keep workspace tools that help a team produce evidence, but remove them from unrelated onboarding requirements.

Defer CREATE, reputation-weighted financial influence, price-multiple unlock ladders, futarchy, automatic market-depth changes to exit, multiple launch modes and social trading P&L. No source deletion is necessary: hide unsupported paths from the public pilot. A funding pilot without a market can validate fundraising and delivery accountability; trading remains a separate product to prove.

After the correctness fixes, the next milestone should be a small hosted testnet cohort of independent founders, backers and reviewers. They should complete a raise, a successful milestone, a rejected or disputed claim, and an exit using their own accounts. Test passkey transactions and account recovery on the actual hosted stack. Local fresh wallets are useful integration evidence; they do not establish that real people understand the agreement.

## Copy

Keep **“Back teams. Follow what they build.”** It is clearer than a list of products being combined. A supporting line could be: **“Back early projects, follow their progress, and see the team's tokens unlock when named reviewers approve delivery.”**

Prefer “team tokens unlock” over “the team earns its tokens”: ownership and voting already exist. Prefer “share of the remaining treasury, while exit is enabled” over “refund” or a guaranteed floor. Prefer “reviewer-approved” over “proven” when a human judgment is the deciding input. The financial details should remain close to the bid, not be squeezed into the headline.

## Validation

Independent current checks: production web build passed; all 745 shared-core and 1,638 web unit tests passed with zero skips; focused homepage, launch and auction browser checks passed 44 cases, with six chain-dependent cases skipped in that smoke configuration. Review agents also ran focused tests and isolated process/state reproductions.

The runner self-test passed its 11 existing assertions with process discovery, server and Anvil stand-ins confined to fixture-owned PIDs. The additional concurrent-state fixture reproduced the deletion defect above. The unsafe occupied-port branch was reviewed without executing it against a real foreign listener.

The real economy browser journey passed against an isolated local chain, real relay and scratch database. It exercised the malformed sale-currency answer with no exit available, recovery through Retry, slashing during a full pending bond withdrawal, reviewed payment, freeze/unwind, budget closure and an exit whose actual USDC payout exactly matched the preview. Auction and governance clocks were advanced by the test. No Solidity changed in D54, and this review did not repeat a full contract audit or establish production deployment readiness.

Design assessment: minimalism 7/10 because the supported paths and onboarding still span multiple products; elegance 8/10 because the agreement is spread across several views; correctness 8/10 because the concrete failures above remain. The corresponding fixes are one pilot format, a shared public milestone timeline, and closing those failure paths. These are review judgments, not security ratings.
