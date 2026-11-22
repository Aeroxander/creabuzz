# Creaton MVP product review — 16 October 2026

> **History (review record), 2026-10-31.** Written for the backer-first product of mid-October; its findings were acted on as D49 to D53, and the MVP is now contributor projects with no raise (D63, D137). The current index is [STATUS.md](STATUS.md).

The strongest product here is a place to back teams, follow their work, and see a defined portion of their tokens become transferable only after agreed delivery is reviewed. The implementation contains substantial pieces of that system. The main work is to make one complete, understandable lifecycle and ensure every promise on the page matches the contracts.

This is a product and integration review, not a security audit or deployment approval. It reviews the current working tree, including existing uncommitted work. Source-backed issues below are distinguished from recommendations and scenarios needing runtime regression tests. The local browser review covered the signed-out home, launch directory and sale wizard; the local build had no configured relay/launch kit, so it did not establish a working hosted raise. No financial transactions were submitted. Historical plans and prior test totals were not treated as current validation results.

**Recommended positioning**

“Back teams. Follow their progress. Team tokens unlock when agreed milestones are approved.”

Be precise about “unlock”: founders already hold and vote with their Shares. Milestones release transfer/burn restrictions on the specified tranches. They do not create all ownership at that moment, and they do not by themselves restrict every treasury payment.

The current VISION documents and homepage prioritize collaboration, communities and AI helpers, with token ownership optional. A funding-first front door intentionally changes that emphasis. Keep the workspace as the place teams produce evidence; put funding, delivery and ownership at the front of the product being evaluated here. This is a positioning decision, not simply a new hero sentence.

**What to take from the reference products**

| Reference | Borrow | Avoid for the first release |
|---|---|---|
| [Fomo](https://fomo.family/) | Easy discovery, following, useful alerts and few steps between interest and an action | A generic memecoin feed, leaderboards or speculative trading features before the core funding loop works |
| [MetaDAO](https://metadao.fi/docs) | A clear ownership proposition, visible treasury authority, coherent founder/backer pages and explicit insider incentives | Treating token voting as futarchy, or implying legal/IP ownership from a token alone |
| [Umia](https://umia.finance/docs/tailored-auctions) | Understandable auction budget/limit-price controls, transparent supply and separation between operating authority and major capital decisions | Copying every auction mode, market and incentive mechanism |
| [Legion](https://legion.cc/for-investors) | Founder quality, contribution history and selecting useful community members | A large opaque reputation score before there are enough real participants and launches to justify it |

Milestone unlocks alone are not unique: [MetaDAO performance packages](https://metadao.fi/docs/performance-packages) already tie founder unlocks to token value and time; [Umia](https://umia.finance/tge) has a conditional performance reserve. The sharper distinction is delivery evidence: which product shipped, what criterion it met, who reviewed it, what objections existed, and exactly how much became transferable.

MetaDAO's current [bid-wall documentation](https://metadao.fi/docs/bid-wall) explicitly labels that mechanism deprecated. Do not make it a parity requirement based on older comparisons.

**Keep the foundation that already exists**

- Atomic launch of DAO, Shares, sale and milestone lock/panel: [DaoLaunchKit.sol](../../contracts/src/DaoLaunchKit.sol).
- Lock enforcement in Shares, covering transfers and burns rather than just one trading venue: [MolochPatched.sol](../../contracts/src/majeur/MolochPatched.sol), [MilestoneLock.sol](../../contracts/src/MilestoneLock.sol).
- One Shares-allocation ballot and finite work budgets: [AllocationVoting.sol](../../contracts/src/AllocationVoting.sol), [TreasuryMandate.sol](../../contracts/src/TreasuryMandate.sol).
- Public chain-read track record, holders, treasury flows and milestones: [RecordTab.tsx](../../web/src/features/launchpad/ui/RecordTab.tsx).
- Community discussion, project updates and a simple place to submit work.

The old “skeleton” and “mirror-only” descriptions in some plans understate the implementation. Updating those documents should accompany the MVP scope decision.

**Release blockers and important product corrections**

1. **Make delivery review possible inside the app.** [FileClaimCard.tsx:145](../../web/src/features/launchpad/ui/FileClaimCard.tsx#L145) commits `hashText(evidence)` and `hashText(check)`, then clears their text. The claim card in [WorkTab.tsx:388](../../web/src/features/launchpad/ui/WorkTab.tsx#L388) offers approval/objection without displaying the evidence packet or acceptance criteria. Store a durable evidence manifest tied to the claim and hash; show the deliverable, criterion, author, submission version and reviewer reasons. A hash verifies content only when the content is available.

2. **Make milestones a first-class journey.** [LockedSharesCard.tsx:113](../../web/src/features/launchpad/ui/LockedSharesCard.tsx#L113) asks users to copy the exact milestone wording into a generic claim. The launch creates the panel but does not pre-create its milestone projects; a later DAO-approved project and manager binding are required before a claim can qualify. See [DaoLaunchKit.sol:239](../../contracts/src/DaoLaunchKit.sol#L239), [TreasuryMandate.sol:180](../../contracts/src/TreasuryMandate.sol#L180), [MilestoneLock.sol:159](../../contracts/src/MilestoneLock.sol#L159). Prefer a launch-created milestone work item and a prefilled “Submit milestone evidence” action. If a later vote remains required, disclose that dependency before purchase. The investor and founder should see the same milestone, evidence, approval count, deadline and next action.

3. **Repair the dispute timing and expose recovery.** The default payout challenge window is three days ([ClaimStake.sol:76](../../contracts/src/ClaimStake.sol#L76)). Freezing a mandate claim requires a DAO action ([TreasuryMandate.sol:246](../../contracts/src/TreasuryMandate.sol#L246)); that action is outside the faster bounded lane ([AllocationVoting.sol:210](../../contracts/src/AllocationVoting.sol#L210)), with a 48-hour review and default one-day execution delay. A new challenge first raised after release therefore lacks a practical margin to finish before payout. This is a source-derived timing finding, not a reproduced exploit. Add a narrowly constrained dispute initiation that can suspend payout promptly, or lengthen the window to cover the full process plus discovery/response margin. Then exercise the actual governance-to-freeze route. The app also needs freeze resolution, budget closure and reviewer bond return; contract methods exist but the normal work UI does not expose these recovery paths.

4. **Define reviewer continuity before locking a team allocation.** Reviewer membership is fixed, and the form silently defaults panel lifetime to two years ([launch-panel.ts:15](../../web/src/features/launchpad/lib/launch-panel.ts#L15)). Loss of quorum or expiration can prevent new claims from becoming eligible. Already bound/reviewed claims require separate analysis; expiration does not universally erase existing eligibility. Show expiry, obtain reviewer participation before launch, and specify a constrained fallback for unavailable reviewers without letting founders choose a friendly replacement panel. Include unbond request and withdrawal screens ([VerifierSet.sol:202](../../contracts/src/VerifierSet.sol#L202)).

5. **Show the allocation the DAO launch actually implements.** The wizard shows sale, team, treasury, liquidity, milestones and community. [daoLaunch.ts:699](../../packages/creaton-core/src/launchpad/daoLaunch.ts#L699) maps these into sale, team and `dao = treasury + liquidity + milestones + community`. The milestone schedule locks the team bucket. These are not six independently funded destinations. Use three MVP buckets: **Public sale / Team allocation locked by milestones / DAO reserve**. Configure liquidity or contributor awards through an explicit later decision unless the launch really executes them. Remove the speculative pool-coverage sentence, whose percentage also disagrees with its own underlying model ([SupplySplit.tsx:203](../../web/src/features/launchpad/ui/create-wizard/SupplySplit.tsx#L203)).

6. **Remove claims of executable action where there is only a discussion record.** “Propose capital return” says it creates a real post-graduation DAO decision, but [LaunchDetailPage.tsx:405](../../web/src/features/launchpad/ui/LaunchDetailPage.tsx#L405) only publishes a Nostr suggestion. [TreasuryTab.tsx:236](../../web/src/features/launchpad/ui/TreasuryTab.tsx#L236) marks it proposed without awaiting publication. Route this to an executable governance draft, or label it “Suggest returning funds” and confirm only after publication succeeds. Merge recorded suggestions and executable decisions into a coherent governance view with explicit status.

7. **Keep the pitch and commitments visible when a sale begins.** The full pitch appears for ideas, but the sale overview does not render the same long pitch/update cadence; team and assets are reduced to counts. See [IdeaOverview.tsx](../../web/src/features/launchpad/ui/IdeaOverview.tsx), [LaunchDetailPage.tsx:481](../../web/src/features/launchpad/ui/LaunchDetailPage.tsx#L481). A sale page needs the problem, product/demo, named team, budget/use of funds, milestones, reviewers and rights before contract details. Distinguish declared commitments from verified chain state.

8. **Make every amount, price and action trustworthy.** [widgets.tsx:156](../../web/src/features/launchpad/ui/widgets.tsx#L156) omits the raise currency when formatting progress; [TreasuryFlowsPanel.tsx:68](../../web/src/features/launchpad/ui/TreasuryFlowsPanel.tsx#L68) displays raw base units. Normalize every figure with the actual currency's decimals and symbol. Replace bid-limit candlesticks with clearing-price/funding progress before trading: [PriceChartCard.tsx:37](../../web/src/features/launchpad/ui/PriceChartCard.tsx#L37) constructs its pre-market chart from recorded maximum bids, not executions. Gate the main button on the real sale window and outcome, rather than displaying “Back” for every non-graduated state.

9. **Use one canonical launch product.** Missing launch-kit config currently defaults the wizard to a minted token instead of DAO Shares ([wizard.ts:176](../../web/src/features/launchpad/lib/wizard.ts#L176)). In that path, the browser says founders confirm milestones themselves and enforcement is optional. A missing deployment must not silently change the ownership product. For MVP, support one network, one raise currency and the own-DAO milestone path. If unavailable, save a draft and explain that launching is unavailable. Hide legacy import/mint, alternate sale and optional enforcement modes from the main flow.

10. **Resolve the trading dependency explicitly.** The official [LBAMM registry](https://apptokens.com/docs/integration-guide/limit-break-amm/reference/contract-registry), checked for this review, lists its core/pools/hooks as `NOT_DEPLOYED`; its [public README](https://raw.githubusercontent.com/limitbreakinc/lbamm-core/main/README.md) describes an evaluation release and excludes live deployment/commercial operation. This is published-document evidence, not a chain-wide proof of absence. The current [Sepolia plan](../sepolia-testnet.md) deliberately excludes the exchange. A funding/milestone testnet can proceed; the Fomo-style liquid trading proposition needs a permitted, verified deployment and operational price history. Treat that as a dependency, with a clear decision date, rather than silently substituting a different venue.

**Contract product semantics to settle and display**

- Founder voting before unlock is a deliberate existing policy. Keep it legible: show founder control, largest-holder concentration and the transferable/locked split before a bid. An address being outside the locked team is not proof of social independence or absence of collusion.
- The lock restricts the originally scheduled tranches. General DAO powers still include treasury spending, new Shares issuance and changing exit availability. Milestones do not cap every way a team could benefit. See [MolochPatched.sol:1112](../../contracts/src/majeur/MolochPatched.sol#L1112) and [MolochPatched.sol:1534](../../contracts/src/majeur/MolochPatched.sol#L1534). Decide which powers remain changeable and disclose them prominently.
- Governance activates before the sale ends and snapshots prior ownership. Add a release regression for a treasury intent opened before buyers claim and executed after proceeds arrive; verify buyers have an effective opportunity to review, oppose or exit. Source inspection identifies this launch-boundary concern; this review did not execute the scenario. A post-claim governance grace period or restrictions on pre-sale intents are possible fixes.
- Ragequit returns a proportion of eligible assets currently held by the DAO, not the original purchase amount and not money already moved into separate work escrows. Show a live exit preview with exclusions and current availability ([MolochPatched.sol:1039](../../contracts/src/majeur/MolochPatched.sol#L1039)). Use distinct language for failed-sale refunds, unused bid-budget refunds, treasury exit and secondary sales.
- Freeze and forfeiture are separate: the DAO can burn remaining unearned founder tranches via `forfeit`; it cannot use that operation to release them for sale ([MilestoneLock.sol:177](../../contracts/src/MilestoneLock.sol#L177)). Display this as a consequential governance power.
- Define “team milestone” versus “individual contributor milestone.” The lock requires the claim contributor to be the beneficiary. A company-level delivery should not make each founder manually recreate the same evidence and acceptance text. The product should coordinate the required individual claims or adopt an explicitly reviewed shared-evidence model.

**Exact copy changes**

| Current text or behavior | Recommended text |
|---|---|
| “Make something with a team of people and AI helpers” | “Back teams. Follow what they build.” |
| Shared-workspace hero paragraph | “Discover early projects, back their raise and follow their progress. A defined part of the team's tokens stays locked until named reviewers approve the agreed milestones.” |
| “Start an idea” and “Set up a sale” as parallel primary entry points | “Create project”, then Draft → Prepare raise → Launch |
| “Your own Shares” | “Team token unlocks” |
| “Founders and contributors, locked with a cliff” | “Team tokens. The milestone schedule below shows what is locked.” |
| “Graduation threshold” | “Minimum raise” |
| “Graduated” | “Funded” or “Sale completed”, with “Market live” shown separately |
| “Ask to be recognised for your work” in the founder milestone path | “Submit milestone evidence” |
| Copy exact milestone words | “Submit evidence for this milestone” with the criterion already selected |
| “Proven commitments” | “Project commitments”, marked “Verified onchain” or “Declared by team” |
| “Propose capital return” when it only creates a record | “Suggest returning funds” |
| “The sale clears at one uniform price” | “Your bid fills over time at the auction's current clearing price, up to your price limit.” |
| Generic “Back” button across states | “Follow launch” / “Place bid” / “Claim tokens” / “Claim refund” / “Trade”, according to actual availability |
| Long server diagnostic in the main empty state | “Projects couldn't load. Try again.” Keep technical details expandable. |

The auction pricing correction is substantive: [Uniswap's explanation](https://support.uniswap.org/hc/en-us/articles/43107626487437-What-are-Continuous-Clearing-Auctions) says pricing is uniform within a batch, while different batches may have different prices. The current [sale explanation](../../web/src/features/launchpad/ui/LaunchDetailPage.tsx#L686) can imply one final price for all fills.

Avoid implying company equity, contractual IP ownership, guaranteed principal recovery or revenue rights without the corresponding specific arrangement. The IP card should retain its distinction between project statements and legally established rights.

**Features to keep, improve or defer**

Keep discovery, project following, project updates/discussion, transparent sale terms, claim/refund management, a first-class milestone timeline, treasury visibility, holder decisions and track record.

Improve discovery around “Raising now”, “Recently funded”, “Milestone submitted” and “Needs review”. Useful social activity is progress, evidence, objections and treasury decisions; distinguish popularity from verification. Preserve direct Communities access, while making team chat/wiki/repositories/AI helpers secondary project tools rather than mandatory steps for a backer.

Defer global trading P&L/leaderboards, reputation tokens, a proprietary composite score, trust-root machinery in default onboarding, futarchy, price-based performance ladders, custom currencies, multiple launch types, multi-network launch setup and desktop/mobile parity. These can remain internal or advanced tools where needed. Do not delete independent useful infrastructure solely because it is hidden from MVP.

Legion-style selection is a future product choice, not finished functionality in the flagship flow: [use-dao-launch.ts:106](../../web/src/features/launchpad/use-dao-launch.ts#L106) rejects curated DAO raises. Start with manually selected founders and open backer participation, or implement one clear allocation gate if it is a hard MVP requirement. Keep reputation as admission/context rather than silently granting voting power.

**MVP release sequence and acceptance criteria**

1. Freeze the offering: one own-DAO raise, one network/currency, three honest allocation buckets, explicit reviewer policy and project terms.
2. Finish evidence submission/review/unlock plus dispute, expired/unavailable panel, rejected claim and bond recovery. Ensure launch-promised milestones can actually be processed without an undisclosed discretionary vote.
3. Correct tokenomics, currency formatting, auction explanation, sale-state actions and suggestion-versus-execution labels.
4. Deploy and host the integrated testnet: patched Summoner/kit, relay/database, browser RPC/history start, passkey bundler/paymaster. Test a launch through the actual bundler; the atomic deployment is large enough that a real bundler's gas limit matters.
5. Exercise two independent testers plus a reviewer on the hosted deployment. Successful sale: bid → claim → treasury arrival → read evidence → review → challenge window → unlock → governance/exit. Failure story: sale misses minimum → user claims refund. Also test lost connection/reload recovery, dispute near payout, unavailable reviewer and bond return.
6. Make the combined real-relay/chain/browser story a release gate; mocked smoke and contract tests remain useful supporting evidence. Then obtain explicit human test confirmation. Independent security review of the final money-handling scope is required before a production-money launch.
7. Open a limited founder cohort. Bring in users who will build and review real deliverables; measure bid completion, evidence review completion, unlock success, recovery success and return visits to project updates. Add trading only when its external deployment and operational requirements are met.

Do not estimate the schedule from file count: the integration and recovery decisions determine the remaining work. The existing code is a strong starting point for a hosted testnet, but this review does not establish that such a deployment is currently live.

**Concrete CROPS record for the proposed MVP**

Chosen default: one-network DAO Shares launch, contract-authoritative balances/rights, signed project evidence on the relay with exportable manifests, and a visible reviewer policy. Keep the exchange dependency optional for the funding beta.

| Property | Concrete risk | Mitigation and user escape |
|---|---|---|
| Censorship resistance | Relay/RPC availability can hide evidence or prevent the normal UI from functioning; panel quorum can withhold unlocks | Exportable evidence, documented alternate RPC/direct contract actions, and a bounded reviewer-continuity policy. Direct contract calls cannot replace unavailable evidence or reviewer quorum. |
| Open visibility | A public contract does not reproduce a hosted deployment or its evidence/indexing state | Publish deployment manifests, ABIs, pinned build/config and the evidence/indexer schema; provide working self-host instructions. |
| Freedom to operate | LBAMM's evaluation release has separate restrictive terms | Keep its source outside this repo and do not operate public markets on that snapshot. Confirm the permitted deployed integration before offering trading; users must be able to run the funding frontend under the core stack's actual licenses. |
| Privacy | Wallet bindings, balances, voting and evidence can connect public identities and activity | Explain what is public before binding/publishing; minimize profile requirements and avoid sensitive evidence in public manifests. Document wallet recovery and infrastructure dependencies. |
| Security and exit | DAO powers, reviewer availability, bond custody and separate escrows affect loss and exit | Show powers and live exit amounts, constrain dispute/recovery authority, test timing, and document how users claim/refund/exit if the frontend operator disappears. Exit remains subject to actual contract state and separate escrow rules. |

Accepted compromises for a testnet: operated relay infrastructure, a named human reviewer panel, a bundler/paymaster dependency for passkeys and no secondary market. These must be visible and tested; they are not evidence of a permissionless, indefinitely self-sustaining product.
