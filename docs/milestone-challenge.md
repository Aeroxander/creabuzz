# Milestones that unlock unless holders object

Status: built and the default for new launches (D56). The named-reviewer panel is unchanged and still offered; a launch
picks one of the two, once, and nothing can change it afterwards.

## Why

The panel asks a founder to recruit several independent strangers before launch, keeps them fixed for two years, and
fails closed: if too few can be reached, or the panel runs out, the team's locked Shares stay locked and nobody can add a
reviewer. The contracts cannot tell a stranger from a friend, so the independence is mostly a promise. What really
protects a backer is that nothing unlocks for a week, the evidence is public, holders can vote, and anyone can leave
with their share.

## The rule

1. A team member publishes evidence for milestone *k* (its hash goes on the chain with the call) and posts a **bond**.
2. A public **window** opens. Backers can still leave with their share while it runs.
3. No objection: anyone can finish it after the window and the milestone's tranche unlocks for the whole team. Each
   team member gets the soulbound badge.
4. Objection: any holder who is not on the team posts a **deposit** and the milestone goes to a **vote of holders**.
   Team Shares do not count.
5. After the vote the objection is **upheld** only if the rejecting weight reaches a small minimum share of the eligible
   Shares *and* is larger than the accepting weight. Anything else, including nobody turning up, means the milestone
   stands and unlocks. (Your call: silence is consent; the bar for an objector is therefore low.)
6. **Clawback**: for a month after an unlock, a holder can object again, once. If that is upheld, every team member's
   remaining locked Shares are burned and the bond is forfeited. The tranche that already unlocked stays unlocked, so
   the last tranche should be the largest.

Nothing here lets a vote free locked Shares. The lock stays set-once, forfeiting still burns instead of freeing, and
the DAO can still forfeit a departed founder's tranches.

## The numbers (set when the project launches, fixed after)

| | Default | Notes |
|---|---|---|
| Window | 7 days | ×2 for a tranche of 25% or more, ×3 for 50% or more; doubles after each rejected attempt (up to ×8); never more than 60 days |
| Vote | 5 days from the objection | |
| Minimum rejecting weight | 3% of eligible Shares | Eligible: everything that exists, less the DAO's own Shares and the team's |
| Bond | 1% of the raise target, in the sale currency | Returned a month after the unlock if nothing was upheld |
| Deposit | 10% of the bond | Back with a bounty if upheld; to the DAO treasury if not |
| Clawback period | 30 days after the unlock | One late objection per milestone |
| Earliest submission | The sale's claim block | Buyers can hold Shares and leave first |

If the objection is upheld before the unlock: the tranche stays locked, half the bond goes to the objector (with the
deposit back), half to the DAO, and the team may try again with a doubled window.

## Who votes, and how much

- Anyone who is not a team member. A team member cannot object or vote on their own milestones.
- Weight is the smaller of the wallet's votes at the block before the objection and the Shares it holds now. Buying
  after the objection counts for nothing, and votes delegated in cannot be used (the Shares would have to be the
  voter's own).
- One vote per wallet per objection.

## What this does not fix

- A team and its friends can buy in the sale and vote "accept" like any other holder.
- If nobody is watching, a bogus milestone unlocks. The bond and bounty exist to make watching pay; Home lists a
  waiting milestone for every holder; an AI helper can check what is checkable (the link is live, the contract is
  deployed). None of that decides anything.
- Shares still sitting unclaimed in the sale count as able to vote when the minimum is worked out, which raises the bar for an
  objection a little until buyers claim them.
- It is new, unaudited contract code. The panel path, which is also unaudited, stays available.

## Rollout (done)

1. Contract and tests: `MilestoneChallenge.sol` (32 Forge tests, each guard broken once to see a test fail), the panel
   untouched.
2. The launch kit makes either (`launch` for a panel, `launchChallenged` for this), each lock from its own factory so every
   contract fits the 24,576-byte limit (a test holds them to it; Forge's own EVM does not, and the first real chain refused a
   combined factory that was 592 bytes over).
3. The shared package plans, encodes (pinned to `cast`) and reads it; the web app's Milestones tab, launch form, Home
   reminders and the DAO's front page follow whichever lock the project has.
4. A real-chain journey (`scripts/web-challenge-e2e.sh`, in the gate): launch, sale, publish with a bond, objection and vote
   upheld, retry with a doubled window, unlock, bond held, a late objection upheld and the remaining locked Shares burned.
5. The launch form's default is now "Holders can object"; "Named reviewers" is one click away.

Not built: `buzz` CLI commands for agents (the lock is driven from the web app only), an AI helper that checks the evidence
(advisory only, by design), and the audit.
