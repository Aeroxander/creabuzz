# The pilot: what Creaton is for the first testers

This replaces the long list of what the product could be with one thing it is: **back a team, understand the agreement,
follow its work, and see its locked tokens unlock as its milestones are reached, unless holders object.** It comes from the third review
(`FIRST-PRINCIPLES-REVIEW-2026-10-17.md`) and is where the decision documents disagree, this wins. The decision documents
(`DECISIONS.md`) are a record of what was built and why, not a rulebook.

## The one format

One network (Sepolia for the pilot), USDC, a project that launches with its own DAO and its own Shares, a sale in which
backers bid, and a team allocation that unlocks milestone by milestone. Everything else is secondary until real people ask
for it.

In the pilot:

- Discover, follow, project updates and the project's page, with its terms before the bid.
- Bids, refunds, collecting tokens, and leaving with a share of what is left in the treasury while leaving is switched on.
- The milestones, public: the agreement, the tokens each one holds back, the evidence the team published, any objection and
  the vote on it, the waiting period and the release.
- Reviewed work budgets as the normal way to pay for work; direct payments stay possible and are shown as spending with no
  delivery review. Disputes (freeze, unwind, take a reviewer's bond) and closing a budget.
- Workspace tools (channels, AI helpers) that help a team produce evidence, but never as part of a backer's first steps.

Not in the pilot, and not to be built before the basic agreement has real usage: CREATE, reputation that weights money or
votes, price-multiple unlock ladders, futarchy or automatic market-depth rules for exit, more than one launch format, and
social trading profit and loss. Nothing here needs deleting; these paths simply are not offered to testers.

## What the promise is, exactly

The team's **original allocation** is locked behind milestones. It is not a promise that raised money cannot leave before
delivery: holders can still vote to spend the treasury or to issue more Shares, and those votes do not wait for milestones.
Say it that way everywhere ("a holder-governed treasury, with milestone-based unlocking of the team's allocation"). A promise
that specified capital cannot leave before delivery would need a protected reserve and different contracts: an agreed
operating budget for the team and the remainder behind explicit release conditions. That is a different product with different
trade-offs, and the pilot does not claim it.

## Words

- Keep "Back teams. Follow what they build."
- Say "team tokens unlock", not "the team earns its tokens": ownership and voting already exist.
- Say "your share of what is left in the treasury, while leaving is switched on", not "refund" or a guaranteed floor. A
  missed minimum raise is different: every bid is refunded.
- Say "nobody objected" or "holders turned it down", not "verified" or "proven": a milestone nobody objects to unlocks, so what
  a backer is shown is the evidence and the chance to object, not a guarantee that it was reached.

## How a milestone is judged

By default the holders judge it, by exception (`docs/milestone-challenge.md`, D56). The team publishes its evidence and
posts a bond; for a week (longer for a big milestone, and longer again after each attempt holders turn down) any holder can
object; with no objection anyone finishes it and the tokens unlock. An objection starts a vote of holders, where the team's own
tokens do not count, and it stands only if more is against the milestone than for it and at least 3% of what could vote is
against it. A month after an unlock one more objection is possible, and if holders uphold it the team's remaining locked
tokens are burned. Milestones go in order, so the tranches still ahead are locked while an earlier milestone can be objected
to; what stands behind the last milestone is the bond, and the page says so. A holder's weight in a vote is the Shares they
owned just before the objection, never delegated votes. There is nobody to recruit, nobody to keep reachable, and no panel that can run out.

The weakness is plain and the page says it: a milestone nobody objects to unlocks, so the protection is only as good as the
attention of holders. The bond and the objector's bounty exist to make watching pay, and backers can leave with their share
of the treasury while a milestone waits. A team and its friends can still buy in the sale and vote "accept" like any holder.

A founder can instead name a panel of reviewers (the earlier model): then the fixed panel stops friendly replacement but can
strand an honest team if too few reviewers answer, so before launch the founder says they asked each reviewer and how the
reviewers will work (how fast, paid or not, any tie to the team), marked on the page as the team's own statement. A backup
panel agreed before funding is worth evaluating for longer projects; unrestricted replacement by an interested majority is not.

## Before inviting people

Fix correctness failures before adding mechanisms. Then a small hosted testnet cohort of independent founders, backers and
reviewers: a raise, a successful milestone, a rejected or disputed claim, and an exit, each with their own accounts, including
passkey transactions and account recovery on the hosted stack. Local journeys with fresh wallets are integration evidence;
they do not show that real people understand the agreement.
