# Running the pilot with real people

Local journeys prove the pieces connect; they cannot show that a stranger understands what they are doing. Each run
below is done with a few people on a hosted server, each on their own account and device, with no walkthrough. They
come in the order of release ([SOCIAL-MVP-ROADMAP-2026-10-19.md](SOCIAL-MVP-ROADMAP-2026-10-19.md)): the social run
first, then a contributor project, and the raise last, after its audit.

## First: the social run (three to six people, an hour)

Before it: the hosted server with the web app, the terms and privacy note finished, two or three boards with real first
posts (starter boards help), and you reachable while it runs. The automated version of this run on a local server is
`scripts/web-social-e2e.sh`; it does not replace this one.

Ask each person to do these on their own, thinking aloud:

1. Sign up (agreeing to the terms), set a name and a picture, and say in a post who you are.
2. Follow two people. Find a board about something you care about, join it, and start a discussion.
3. Vote on three posts, reply to one, and answer a reply to you (find it from the notifications).
4. Report something (the organizer plants an obvious spam post). Mute someone, and check that they are gone from Home,
   the boards and the notifications.
5. As a board's owner: lock a thread, pin one, write the rules, appoint one of the others as moderator. As that moderator:
   find the report, remove the post with a reason. As its author: find out that it was removed and why.
6. Come back the next day: what changed while you were away, and could you tell?

Watch for: anyone who cannot sign up or loses their account; anywhere they wait for something that never arrives
(a reply, a notification, a removal); words they ask about; whether a moderator's action reads as fair to the person it
was taken against. A good run is one in which nobody needs help, and the moderator's removal is understood by its
author without anyone explaining it.

## Second: a contributor project (a founder, two reviewers, three or four contributors, about a week)

Before it: the contributor kit on the test network (`scripts/sepolia-deploy.sh --broadcast`, yours to run), a faucet or
a funded account for gas, passkey sign-in working on the hosted server, and the first project typed in from
[CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md) with its two reviewers chosen. The automated versions on a local
chain are `scripts/web-contributor-e2e.sh` and the MVP gate (`scripts/mvp-gate.sh`).

- **The founder** (an hour on the first day): start the project from Start, post the invitation in General, answer the
  first questions on the supporters board, and later put an award to a vote.
- **Each reviewer** (half an hour, twice): accept a piece of work for review, read the evidence against the work area's
  exact words, approve one and turn one down with a reason.
- **The contributors** (at least one new to crypto, one doing non-technical work, one who joins a few days late and knows
  nobody): find something to do from Ways to help, submit it, follow it through review, the 7-day window and the award
  vote, and look at the Contributions page afterwards.

Ask each contributor afterwards, without prompting:

1. "What could you do here without owning any Shares?" Submit work, suggest work, discuss.
2. "Who decides right now whether your work is accepted, and who decides the award?" The reviewers judge the work
   against its words; the holders vote the award (and today the founder holds most of the vote, which the header says).
3. "What did approval give you, and what did the award give you?" Approval is the reviewers' verdict; Shares arrive only
   with the award vote, and they are locked against transfer.
4. "Can you sell your Shares?" No: they are locked; there is no market.

Watch for: how long the first review took, what happened to the piece that was turned down, whether Needs you told each
person their next step, and the visit after a day away. A good run is one useful piece of work reviewed, awarded by vote
and understood by the person who did it, including someone who had never used a wallet.

## Third: the raise (after the audit)

`PILOT.md` says what the raise pilot is. What follows is how to run it. Run it with a small group (three founders, six
backers, six reviewers is plenty) on a hosted testnet, each person on their own account and device.

### What has to exist first

- A hosted server people can reach, with the web app, and a chain connection for one test network (Sepolia).
- Test USDC for backers and founders, and a way to give it out (a faucet or a funded account you hand it from).
- Passkey sign-in working on the hosted stack, including losing a device and signing in again. If this does not work, nothing
  else is worth testing yet.
- A named person on your side who can answer within the hour while a session runs.

### The raise scripts

Give each person only their script and ask them to think aloud. Do not explain the product first.

**A founder** (60 to 90 minutes). Publish a project and its idea. Set up the sale: three milestones in words a stranger could
check, the raise and its length. Launch it with "Holders can object" (and, for one founder, try "Named reviewers" too: the
founder must ask the three reviewers first and say how they will work). Post an update. Then, once a backer has bid and the
sale has ended, publish the evidence for the first milestone and post the bond.

**A backer** (30 to 45 minutes). Find a project. Read what you are agreeing to. Say aloud, in your own words, what happens to the
team's tokens and what could still happen to the money. Bid. Follow the project. After the sale, collect your tokens. Then
decide whether to leave with your share, and do it or say why not.

**A holder who watches** (30 minutes). You bought in during the sale. Find the milestone that is waiting for objections (Home
points to it). Read the evidence and the words it is judged against. Decide whether it was reached: object, or say why you
would not. If someone objects, vote. Later, find out whether the unlock happened.

**A named reviewer** (only for the founder who chose that option, 30 minutes). Receive an address from the founder, connect a
wallet, post the bond. Read the evidence for a milestone. Approve it, or object and say why. Later, find out whether the unlock
happened.

### The questions that matter

Ask each backer, without prompting, after reading the project page and before bidding:

1. "What happens to the team's tokens?" The right answer: locked until each milestone is reached; the team publishes evidence,
   holders can object until the deadline the page shows (a week to start with; longer for a big milestone or a retry), and with
   no objection it unlocks.
2. "Can the team spend the raised money before a milestone is reached?" The right answer: yes, holders can vote to spend it;
   the lock is on the team's own tokens, not on the money. If they say no, the page has misled them.
3. "What happens if the sale does not reach its minimum?" Every bid is refunded.
4. "What can you do if you stop believing in the project?" Leave with a share of what is left, while leaving is switched on.
5. "Who decides whether a milestone was met, and can that be changed?" Holders, by objecting and voting (the team's own tokens
   do not count); the rule is fixed at launch.
6. "What happens if nobody objects?" It unlocks. If they say it needs someone's approval, the page has misled them.

Anything people get wrong is a page to fix, not a person to correct.

### What to watch and write down

- Where they stop, scroll back, or ask what a word means. Copy the word.
- Any step that needed your help, and what you said.
- Every error message they saw, and whether they knew what to do next.
- Time to finish each script.
- For founders: whether they could write a milestone another person could check, and whether they asked their reviewers first.
- For holders who watch: whether they noticed the milestone without being told (Home's "waiting on you"), whether they could
  tell if the evidence matched the words, and whether they understood what their objection costs and what it can win.
- For named reviewers: whether they understood the bond and when it can be taken.

### What a good raise pilot looks like

A raise that completes, a milestone that is published and unlocks, one that holders turn down and the team publishes again,
a work claim that is reviewed and paid, a dispute that is frozen and resolved, and an exit, each done by people who were not
told how. If any backer cannot answer questions 1, 2 and 6 correctly after reading the page, fix the page and run another
backer before anything else.
