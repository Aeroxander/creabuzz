# Creaton: one DAO OS, a useful overview, and an investor experience — 18 October 2026

> **History (review record), 2026-10-31.** The all-in-one DAO OS and investor framing it reviews was replaced by the social MVP, then contributor projects with no raise (D63, D137). The current index is [STATUS.md](STATUS.md).

Reviewed changes after `0b5ec8f72` through `c7342e0df`, preserving the unrelated working tree. The scope expanded during review: the target is an all-in-one DAO OS with work, fund and AI management, plus a Fomo-inspired investor experience. The recommendations below retain that target. Narrowing a test cohort is an execution choice, not a reason to discard the rest of the product.

## Latest changes

The previous delegation vulnerability is fixed with ownership checkpoints rather than delegated votes, and both attacks now have regression tests. Challenge screens distinguish transport errors from a confirmed panel, refresh while watched, show freshness and Retry, preserve evidence read states, remount drafts by wallet/lock/milestone, and gate publishing before the claim block. Global and project copy now describe the optimistic default. The journey scripts use their recorded Anvil PID instead of killing a listener found by port.

Independent validation: production build passed; 763 core and 1,711 web tests passed with zero skips; Foundry passed 394 tests with two optional fork tests skipped. The unchanged challenge browser journey passed on its own local chain, including live updates, an unreadable lock, failed evidence reads and recovery. Its relay is mocked; this is not a hosted passkey or production operations test.

Two prior concerns remain partly open:

1. **[P2] Sequential publication does not preserve collateral throughout earlier late challenges.** [MilestoneChallenge.sol:312](../../contracts/src/MilestoneChallenge.sol#L312) requires the previous milestone to have stood. It does not wait for that milestone's late-challenge period or block a later unlock while the earlier vote is open. A production-contract reproduction with the default 20/30/50 schedule unlocked milestones on days 7 and 21, submitted the final milestone, opened a late objection to milestone two on day 40, unlocked the final tranche on day 42, and upheld the objection on day 45. Zero Shares were burned. The UI's statement that the milestones ahead remain locked while an earlier one can be objected to is stronger than the guard. Keep the sequencing benefit, but either retain collateral until earlier late votes/periods finish or state that only the bond and any still-locked Shares are at risk, for every milestone. The isolated reproduction is `/private/tmp/creabuzz-milestone-review-d57/test/ReviewD57.t.sol`.

2. **[P2] An empty lock response still becomes a confirmed non-challenge mode.** [milestoneChallenge.ts:281](../../packages/creaton-core/src/launchpad/milestoneChallenge.ts#L281) substitutes zero for an absent ABI word, and [the count read](../../packages/creaton-core/src/launchpad/milestoneChallenge.ts#L325) treats zero as null. Calling production `readChallengeLock` with an RPC response of `0x` reproduced null. A valid new challenge lock cannot have zero milestones. Validate the ABI response and count; empty/truncated/impossible responses must remain unreadable rather than selecting another mode. The transport-exception fix itself works.

These findings do not require reopening unrelated areas. The original voting exploit and most UI/recovery failures are closed. The sequential change adds a useful project rule, but its stronger collateral claim should not be treated as proven by the current tests.

## The product structure

The problem is less a lack of surfaces than a lack of continuity between them. Current global navigation separates Home, Social, Communities, Discover, Launches and Portfolio. Inside Communities are Work, Org, AI helpers, discussion and docs. The launch page has its own Work, money, decisions and milestones. These are legitimate functions, but the user must assemble the project in their head.

Use two levels of overview:

- **Personal Home:** what needs me, what changed across my projects, and what people I follow are doing.
- **Project Overview:** what this project is trying to deliver, where delivery stands, what money is available or committed, who is doing the work, and what needs a decision.

Recommended global navigation: **Home / Discover / Workspaces / Portfolio**, plus search, notifications and account. Launches become a Discover category and a project lifecycle, rather than a separate mental universe. Social activity belongs on Home and on people/project pages. Existing routes can remain reachable; this is a navigation and aggregation change, not a router migration.

Within a project: **Overview / Work / Money / Agents / Community**. Milestones remain a prominent direct destination from Overview and relevant work; decisions and funding claims are explicit destinations within Money/Work. Community includes channels, boards, docs and code. A role preference changes ordering, not authorization, and one person can invest, contribute and operate simultaneously.

## What the overview should answer

In a few seconds, a user should be able to answer:

1. What is this project, and why do I care?
2. What changed since my last visit?
3. What needs my action, by when, and what happens if I do nothing?
4. What is the next delivery, what evidence exists, and what is blocking it?
5. Where is the money: available in the DAO, committed outside it, paid, and planned spending?
6. What are people and agents doing, and who is accountable for reviewing them?

Lead with a short, ranked action queue. A milestone objection deadline, a payment awaiting approval and a blocked agent deserve more prominence than unread chat or a generic task count. Group informational updates into a digest. Give every item a direct action and a reason it appears. Keep failed/incomplete reads visible; do not turn them into a reassuring empty inbox.

Money figures need explicit scope: treasury balance, committed escrow, spent funds, investor market value and treasury redemption value are different measures. Runway is an estimate based on a stated spending plan, not a fact obtained by dividing unrelated historical totals. Every dynamic section should carry its source/freshness and a recovery action.

## Make the OS connected

The canonical working loop should be **milestone → tasks → human/agent execution → review → evidence → funding claim or token unlock → public progress**.

A task detail should bring together its owner, agent run, discussion, output, acceptance criterion, review and any linked payment claim. Finishing a task must not automatically transfer money. Accepting agent output and authorizing treasury payment are distinct actions.

Keep the current relay tasks and onchain claims as distinct records, linked under a common project context. Do not put every task onchain or replace existing Nostr events merely to make the UI look unified. Reuse the existing work, org, treasury and decision readers to build a shared project summary. Preserve community access boundaries; a public investor view should not expose private team channels or sensitive agent traces.

Agent management should answer: **what is it doing, for whom, with what authority, at what estimated cost, and what needs approval?** Start with a named owner, current task, useful output, allowed tools, spending ceiling, last activity and recovery controls. Make advanced provider/token diagnostics expandable. A friendly name or avatar can help, but the useful output and accountable owner should remain primary.

## What Fomo actually contributes

This comparison uses Fomo's official public material, not decompiled code or an authenticated native-app walkthrough. It establishes a feature map, not exhaustive parity with every shipped screen.

| Capability documented by Fomo | Creaton working-tree evidence | Next product step |
|---|---|---|
| Following, social activity, trader profiles and alerts | Posts, follows, profiles, cashtags, bookmarks, discussions and wallet bindings exist | Verified activity cards linking actual bids/trades, project updates and delivery outcomes; explicit publication controls |
| Trade theses on token and global feeds | Project posts and discussions exist | Attach a person's explanation to a verifiable position/event; preserve the difference between opinion and transaction evidence |
| Unified balances, cross-chain swaps and quick buys | Connected/passkey wallet and raise participation exist; market interfaces depend on a venue | Reliable spot execution, quotes, approval/fee/slippage preview, deposits and withdrawals; cross-chain execution is a separate integration |
| Portfolio and P&L | Portfolio shows backed raises, Shares held and work credit | Indexed fills and cost basis; separate realized/unrealized P&L, fees, transfers and unknown prices from treasury exit value |
| Leaderboards and shareable trading identity | Profiles and contribution history exist | Opt-in performance with comparable periods and disclosed accounting; contribution and delivery records should have their own context |
| Advanced charts with social overlays | Sale prices and market/candle adapters exist | Real market data and executions first; then chart overlays for trades and milestone events |
| Apple Pay funding, biometric security and tax integration | Passkeys and wallet identity are present | Provider integrations and real hosted recovery; native biometric app locking is a separate user path |
| Perps, isolated margin, take profit and stop loss | Not established by this review | A distinct advanced trading module and execution-provider integration; it need not enter the DAO treasury's authority |

Primary sources: [Fomo web](https://fomo.family/blog/announcing-fomo-web), [trade theses and social updates](https://fomo.family/blog/february-2026-recap), [onramp, security and tax tools](https://fomo.family/blog/january-2026-recap), [charts](https://fomo.family/blog/tradingview-partnership), [perps](https://fomo.family/blog/perpetuals-now-on-fomo), and [App Store listing](https://apps.apple.com/us/app/fomo-never-miss-out/id6741115427).

Do not equate a social “follow” with automatic copy execution; the reviewed marketing features do not establish a complete copy-trading product. Likewise, educational FAQ topics do not prove that the corresponding trading feature is implemented.

If Discover later includes outside tokens, distinguish them from projects launched with Creaton's DAO agreement. An external token must not inherit milestone or treasury protections merely because it has a page in the app. Private wallet activity must not become a public identity feed by default.

## Make it enjoyable through meaningful progress

The strongest social loop is **discover a person/project → understand their thesis → follow or participate → see actual progress → discuss it → contribute or invest again**. The builder loop is **find useful work → collaborate with people/agents → ship → receive credit → show the result**. Both can share the same activity feed without reducing everything to token price.

Useful engagement features:

- A visual project identity: cover, icon, short mission, team and a memorable build log.
- Shareable release and milestone cards with the actual outcome: submitted, unopposed unlock, rejected, or confirmed by the named panel. “Unlocked” must not silently mean “independently verified.”
- Reactions, threaded discussion, polls, project demos, office hours and a weekly progress recap.
- Credit people and agents together for accepted work, with a route back to the artifact.
- A short celebration when work is accepted or a release ships, honoring reduced-motion preferences.
- Optional public investor profiles and investment theses; separate project-delivery history from financial performance.
- Notifications people choose: my approvals, impending challenge deadlines, followed-project releases, selected market activity. Use batching and quiet defaults for ordinary activity.

Avoid rewarding transaction count, repeated posting, fabricated agent activity or rushed financial action. Do not make contribution badges into voting weight. A meaningful achievement should point to inspectable work; praise or a streak is not evidence of authority or ownership.

## Build order while retaining the full OS

1. Close the two remaining review concerns and establish the exact unlock/late-penalty promise.
2. Build the shared Project Overview and task detail linking existing work, agents, evidence and money. Put one ranked personal action queue on Home.
3. Add the social activity spine: following, project releases, confirmed investment events, explanations and discussions, with opt-in wallet publication.
4. Finish the investor foundation: reliable spot venue/execution, portfolio accounting, prices, transaction history and alerts. This is infrastructure and product work, not another dashboard.
5. Extend to cross-chain balances, onramps, advanced charts, tax exports/integrations and advanced instruments through deliberate integrations. Keep those on the product roadmap rather than pretending launchpad participation already provides them.

No exact schedule is justified without selecting the trading execution and data providers. The point of this order is to reuse the DAO OS's existing strengths while giving investors a coherent product, not to reduce Creaton to a launchpad.

Test the overview with investors, contributors and operators. Ask each to locate their next action, explain the project's next milestone and its spending authority, find an agent's owner and limit, and distinguish market P&L from a treasury exit. Observe whether people return for progress and useful relationships. That evidence should determine the next engagement features.

## Review judgment

Correctness has improved materially: the delegated-vote exploit and most prior recovery problems are fixed. The remaining ABI-mode and collateral statements are concrete, reproducible issues. Minimalism and elegance improve when existing capabilities share a project context and an action queue; adding a summary card for every subsystem would recreate the current fragmentation. The full DAO OS and an understandable overview are compatible if navigation follows users' jobs and data keeps its authority boundaries.

Review judgments: minimalism 8/10 and elegance 8/10 because the same project is still divided across navigation and work/funding surfaces; fix that with shared project context, a linked task detail and two useful overviews. Correctness 8/10 because the two remaining findings need either code changes or an accurate narrower guarantee. These are review judgments, not security assurance scores.

The proposed personal-first and project-first overview concepts were also exercised separately from the application: role prioritization, work/agent review, payment-proposal preview and project navigation worked without JavaScript errors. Layouts were inspected in light and dark appearance, at desktop, phone and 320px widths, with no horizontal overflow in the checked personal view. All displayed project values are sample data, and these concepts are not implemented application features.
