# Running the pilot with real people

Local journeys prove the pieces connect; they cannot show that a stranger understands what they are doing. Each run
below is done with a few people on a hosted server, each on their own account and device, with no walkthrough. They
come in the order of release ([SOCIAL-MVP-ROADMAP-2026-10-19.md](SOCIAL-MVP-ROADMAP-2026-10-19.md)): the social run
first, then a contributor project, then a milestone test on the test network, and the raise last, after its audit. What
each run finds goes in [PILOT-REPORT.md](PILOT-REPORT.md).

## First: the social run (three to six people, an hour)

Before it: the hosted server with the web app, the terms and privacy note finished, two or three boards with real first
posts (starter boards help), and you reachable while it runs. The server is invite-only, so each person needs their own
invite link, and a picture upload has to load back before anyone is asked to add one (steps 3 and 4 of the contributor
run's list below say how). The automated version of this run on a local server is `scripts/web-social-e2e.sh`; it does
not replace this one.

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

## Second: a contributor project (a founder, two reviewers, three or four contributors, about fifteen days)

> **Updated 2026-10-28.** The scope is the MVP: the server, the web app and contributor projects, with no raise and no
> sale. Nothing new gets built for this run (D137); what it finds gets fixed.
>
> **Updated 2026-10-29**, after the readiness audit: contributor steps work from passkey accounts with fees covered
> (D139), the run is about fifteen days (the contracts' waits), and the list below has the server settings, invite
> links, the picture check and the reminders you send.
>
> **Updated 2026-10-30**, after the second audit: the founder (not the reviewers) accepts each piece for review, someone
> must finish each review to start its 7 days, the turn-down is closed by anyone once enough reviewers object, passkeys
> must be synced before day 1, the picture check matches member-only pictures (D142), and the node check sends the
> request the app sends.

### Before it (yours to do)

1. **The test network deploy.** Put a testnet-only `DEPLOYER_PRIVATE_KEY` with test ETH in `.env`, run
   `scripts/sepolia-deploy.sh` (the rehearsal on a fork, no key needed) until it passes, then
   `scripts/sepolia-deploy.sh --broadcast`. Keep the manifest it writes (`contracts/deployments/`). It prints the
   settings for this run first, ready to paste into `deploy/compose/.env`.
2. **The hosted build**, the Creaton image from [deploy/compose/README.md](../../deploy/compose/README.md) ("Creaton"),
   with only what this run uses: `VITE_LAUNCHPAD_CHAIN_ID`, `VITE_CHAIN_RPC_URL`, `VITE_CONTRIBUTOR_KITS`,
   `VITE_HISTORY_FROM_BLOCKS`, the ZeroDev settings, and `VITE_ERROR_REPORT_URL` (the release defaults to the source
   revision). The image takes nothing else, which is the point: each optional feature (bounties, matched exits, weekly
   rounds, payouts, the court, CREATE, forecasts, remixes, raises) adds a screen people would have to understand, and
   none is what this run measures.
   - **The ZeroDev project**: one on Sepolia, with a gas policy that sponsors every operation the run sends: starting
     the project, submitting work, a reviewer's bond, accepting and reviewing, finishing, and opening, voting and running
     decisions. Contributor steps then work from a passkey account with its fees covered (D139), so nobody needs a
     browser wallet or test ETH. A policy limited to a list of contract addresses will not do: each project's DAO and
     work contracts are made when it starts. Set a spending limit sized for the run rather than leaving it open. The
     build refuses a contributor-only image without the ZeroDev settings, or with any `CHANGE_ME` left in a `VITE_` line.
   - **The page's chain node** (`VITE_CHAIN_RPC_URL`): it must allow a wide `eth_getLogs` range. The app reads awards,
     work and votes from the deploy block onward, in pages the size the node allows when it refuses the whole range, and
     stops after 120 requests. Sepolia makes about 7,200 blocks a day, so a node that allows 10,000 blocks a request lasts
     about five months; one that allows 1,000 lasts about 17 days, which this run would outlive. Check it with the request
     the app sends first, using the manifest's `block` and the contributor kit's address:
     `cast logs --from-block <block> --to-block latest --address <contributor-kit> --rpc-url "$NODE"`.
     An answer within a few seconds is fine, even an empty one; a timeout is not. An error about the block range means the
     app will page: [docs/sepolia-testnet.md](../sepolia-testnet.md) (section 3) says how to check that it lasts.
   - **Its request limit** has to cover every participant opening project pages at once (a page sends a dozen or more
     reads). A busy node shows people "The chain node is busy. Try again in a minute", and sends you a `chain-busy`
     error report.
3. **The hosted server**: the same stack, served over HTTPS (passkeys need it), with the relay's read state
   (`BUZZ_V1_ENABLED=true`, in the Creaton part of `.env`), Postgres and Redis, and the web app served by it. Add the
   chain the server checks passkey accounts against, or it refuses to link one to a person:
   `BUZZ_EVM_AUTH=1`, `BUZZ_EVM_CHAIN_ID=11155111` and `BUZZ_EVM_RPC_URL=<a Sepolia node>`. Then check, on a phone and
   a laptop: passkey sign-in; losing a device and signing in again with the recovery key; the terms at sign-up
   (`curl -fsS https://<host>/api/join-policy` names a version); "Show your name with this account" from a brand-new
   passkey account, before its first step; and one practice project started from a passkey account (one large
   operation, which a bundler may refuse: [docs/sepolia-testnet.md](../sepolia-testnet.md), section 4).
4. **Pictures, before inviting anyone.** Upload a profile picture, a picture in a board post and a project cover. Then,
   signed in as a second member on another device, check each one shows. In that browser's network panel, each
   picture's address must be on your public host (not `localhost` or the storage container's name). Pictures are for
   members only (D142): opening a picture's address in a private window is refused, and that is right, not a broken
   upload. The first thing everyone is asked to do is add a picture.
5. **Invite links, one per person.** The server is invite-only (`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`), so nobody gets in
   without one. As the community's owner or an admin, open **People** in the community and make one link per person:
   "One person", lasting a week. Send each link to its person privately; it already names the community's address. Make
   the late contributor's link on day 3, not before.
6. **Names with passkey accounts.** A passkey account is a new address nobody knows, so until its owner links it,
   reviewers and voters see only the address and the founder cannot pick reviewers by name. Ask each person, after
   signing up, to use "Show your name with this account" in the account strip on the contributor screens (one passkey
   prompt). The reviewers do it before day 1.
7. **Synced passkeys.** Awarded Shares and any money in a passkey account can be reached only with that passkey: the
   recovery key brings back a person's name, not their passkey account. Before day 1, each person confirms their
   passkey is saved in their phone's or computer's password manager and synced (iCloud Keychain, Google Password
   Manager, or a password manager they use on two devices), not only on one device or a hardware key. Do not invite
   someone whose passkey is not synced.
8. **The error reports**: `VITE_ERROR_REPORT_URL` set and checked (docs/error-reporting.md). During the run, look at the
   collector and at the ZeroDev project's spending each day: a `sponsor-refused` note means every passkey step is failing
   for everyone until you raise the limit or widen the policy, and retrying will not help them.
9. **The project**: typed in from [CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md) by the founder themselves, with
   two work areas whose words a stranger could check, and its two reviewers asked first (who they are, how fast they will
   answer, any tie to the founder). With two reviewers the form asks both to agree; a split then decides nothing until the
   piece lapses. Either name a third reviewer, or choose "Let any one decide", and tell the reviewers which. With "Let
   any one decide" the first answer decides: one approval approves a piece, and one turn-down turns it down (anyone can
   then close it as turned down, and any deposit goes to the treasury), so the other reviewer cannot overrule it.
10. **The automated versions**, green on the build you host: `scripts/mvp-gate.sh` (it includes the contributor, work,
   paid-work and milestone journeys). They do not cover a reviewer acting from a passkey account or the name link against
   your real server, so in step 3's practice project have one reviewer approve from a passkey account, and have each
   reviewer's name show in the founder's reviewer picker (step 6).
11. **The report**: a copy of [PILOT-REPORT.md](PILOT-REPORT.md) to fill in as it runs.

### The fifteen days

The waits are the contracts' own and cannot be shortened during the freeze. Once enough reviewers approve a piece,
someone has to finish the review ("Finish the review" in Needs you and on the Work tab; anyone may); its
**7 days** start only then (time for anyone to dispute it). Then its contributor marks it finished, and only then can its
award be put to a vote. The vote is open at least a day, its support must hold six hours, and it waits one more day before it can run:
about two and a half days. So a piece whose review is finished on day 4 is awarded on day 13 or 14, and the run is about
fifteen days.

Nothing reaches people outside the app: no email, no browser notification. Each person sees waiting work only when they
open it (Needs you, Home). So you message them yourself on the days below, outside the app, saying what is waiting.

| Day | Who | What |
|---|---|---|
| Before 1 | Everyone | Sign up from their own invite link, set a name and a picture, show their name with their passkey account, confirm the passkey is synced |
| 1 | Founder | Start the project from Start, post the invitation in General, answer the first questions on the supporters board |
| 1 | You | Message the founder and both reviewers: the project is up, the founder accepts each piece for review as it comes in, and reviews are due on days 2 to 4 |
| 1 to 3 | Contributors | Find something to do from Ways to help, submit it (at least one piece each) |
| 1 to 3 | Founder | Accept each submitted piece for review ("Accept for review" in Needs you): only the founder can, as each work area's manager, and reviewers see nothing to review until then |
| 1, 2, 3 | You | Message the founder: which pieces are waiting to be accepted for review |
| 2 to 4 | Reviewers | Read the evidence against the work area's exact words, then Approve, or "Turn it down" and write the reason |
| 2, 3, 4 | You | Message each reviewer: which pieces are waiting for them |
| 2 to 4 | Contributor or founder | Once enough reviewers approve a piece, press "Finish the review" (Needs you): its 7 days start only then |
| 2 to 4 | Anyone | Once enough reviewers object to a piece, press "Close it as turned down" |
| 3 | You | Make the late contributor's invite link and send it |
| 3 | A late contributor | Joins knowing nobody, finds work, submits (accepted by the founder and reviewed by day 4) |
| 4, 5 | You | Message the founder and contributors about any approved piece whose review is not finished yet |
| 4 to 11 | Nobody | Each approved piece waits its 7 days |
| 9 to 11 | Contributors | Once a piece's 7 days are over, Needs you says "Finish it": mark it finished |
| 9 to 11 | Founder | Put each finished piece's award to a vote |
| 9, 10, 11 | You | Message each contributor whose piece's 7 days ended, and the founder once it is marked finished |
| 10 to 12 | Holders | Vote on each award |
| 10, 11, 12 | You | Message the holders: which awards are open for a vote |
| 12 to 14 | Founder | Run each award once its wait is over |
| 12, 13, 14 | You | Message the founder: which awards can run |
| 15 | Contributors | Look at the Contributions page: what they did, who reviewed it, what it was awarded. Then the questions below |
| 15 | One contributor (optional) | Only if the DAO holds something (you sent it test money): open Funds and try "Leave and take my share" from the passkey account. Before confirming, say aloud what they give up and what they receive. Leaving destroys their Shares; with nothing in the treasury it pays nothing |

The invitation in General says the run lasts about fifteen days, and that most of the second week is a wait.

The contributors: at least one new to crypto, one doing non-technical work, and the late one above. Plant one piece of
work that does not meet its words, so that one turn-down happens for a reason everyone can see: the founder accepts it
for review like any other, both reviewers press "Turn it down" and write why, and then anyone presses "Close it as turned
down". The contributor should find the turn-down and its reason without being told.

### Ask each contributor afterwards, without prompting

1. "What could you do here without owning any Shares?" Submit work, suggest work, discuss.
2. "Who decides right now whether your work is accepted, and who decides the award?" The reviewers judge the work
   against its words; the holders vote the award (and today the founder holds most of the vote, which the header says).
3. "What did approval give you, and what did the award give you?" Approval is the reviewers' verdict; Shares arrive only
   with the award vote, and they are locked against transfer.
4. "Can you sell your Shares?" No: they are locked, and there is no market.
5. "If you disagreed with a turn-down, what could you do?" Read the reason, fix the work and submit it again, or ask on
   the board.

### Watch, and write in the report

How long each review took, what happened to the piece turned down, whether Needs you told each person their next step,
the visit after a day away, every error message and whether the person knew what to do next, and every word someone asked
about. A good run is one useful piece of work reviewed, awarded by vote and understood by the person who did it, including
someone who had never used a wallet.

## Third: the milestone test (a testnet launch, no real money)

Milestone locks belong to raises, which wait for the audit. They can still be tried with test USDC, so that a real team
has worked through one before any money depends on it. [MILESTONE-TEST-PLAN.md](MILESTONE-TEST-PLAN.md) has the plan:
small deliverables anyone can check, the order, and what to measure.

The hosted image takes no raise kit (it offers contributor projects only), so this run needs a separate test-raise build.
How that build is made is a decision for later, before this run; nothing is built for it now.

## Fourth: the raise (after the audit)

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
