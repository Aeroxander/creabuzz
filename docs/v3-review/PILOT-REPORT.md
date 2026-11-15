# Pilot report

One copy per run ([PILOT-RUNBOOK.md](PILOT-RUNBOOK.md)), filled in while it runs, not afterwards. It measures whether
the agreement works between real people, not whether the code runs: the journeys already show that. Every number here can
be read from the app (the page named beside it) or from the chain; write down where each came from.

**Run:** Pilot A (founders, no chain) / contributor project / milestone test / raise · **Dates:** … · **Hosted build:** `VITE_APP_RELEASE` … ·
**People:** founders …, (contributor run: reviewers …, contributors … (who was new to crypto, who joined late))

**What counts as a yes for the one number** (written before day 1, from [PILOT-RUNBOOK.md](PILOT-RUNBOOK.md), "Pilot A"): …

## Before the run: the operator's own checks

Nothing here is a number about founders; it says whether the server was fit to invite them to. One row each, filled in as it
is done, with the date. A row left empty means it was not done.

| Check | Where it is written | Date | Result |
|---|---|---|---|
| Restore rehearsal: the real backup, restored on a second machine | [RESTORE-REHEARSAL.md](RESTORE-REHEARSAL.md) | … | … (the backup's name, and each check of its section 3) |
| Uptime alert reaches the phone (the test monitor, then deleted) | deploy/compose/README.md, "Uptime check" | … | … |
| `scripts/mvp-gate.sh --pilot` on the build you host | [MVP-GATE-CI.md](MVP-GATE-CI.md) | … | … passed, … failed |
| `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true scripts/real-loop-e2e.sh` (the loop on an invite-only server) | the findings below | … | … |
| Creaton's own project is up, with its first update | [CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md), Part A | … | … |

## 1. Founders and their updates (Pilot A; the one number)

Read from the server, not typed: on the pilot server, in `deploy/compose`, `./run.sh founders --csv` for the table and
`./run.sh founders` for the totals under it. Paste both, with the date they were read. The operator's own project is left
out of every row (the owner's key, and any in `BUZZ_PILOT_EXCLUDE`).

**Read on:** …

| Founder | Project | Days live | Updates | Weeks with an update | Per week | Update 2 | Update 3 | Days since last | Promises | Kept | Missed | Changed | Never answered | Help asked | Offers | Tasks | Accepted |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | | | | | | | |

**Totals:** founders …, posted a first update …, a second …, a third …; second on time …, third on time …; second after a
late flag …, third after a late flag ….

"After late flag" means the update came more than 7 days after the one before it, which is when the project was on
`./run.sh due`. The server cannot see whether you messaged the founder, so the log below is what says whether an update
came "without being asked".

**Messages sent to founders** (every one, with the date and the words):

| Date | Founder | Why (on the due list: day, days late) | What was said | Did an update follow, and when? |
|---|---|---|---|---|
| | | | | |

**The verdict on the one number**, against the line written at the top: … (and the founders who posted a third update
without a message from you: … of …).

## 2. What founders said (Pilot A)

The answers to the runbook's six questions after day 7 and after day 14, one line each, in their words. Then where they
stopped (sign-up by invite link, Start, "Post update"), what they asked about, and every error message.

## Findings from the loop journey (2026-11-15)

The project loop (`scripts/real-loop-e2e.sh`, ten flows, three browsers, the `buzz` command line and a socket, a real server
and its Postgres) was run on 2026-11-15 on an open server and on an invite-only one, as the pilot server is. These are
agent-run checks, not the founders' pilot, and the numbers below are the journey's, not a hosted run's.

- **Open server** (`scripts/real-loop-e2e.sh`): 10 of 10 flows passed, 5.0 minutes of browser time, about six minutes with
  the server's start.
- **Invite-only server** (`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true scripts/real-loop-e2e.sh`): 10 of 10 passed, 4.6 minutes. The
  first run of it failed at flow 7 (made-up accounts that were not members) and at flow 9 (below); the journey was changed
  to give each browser an invite link (made by the owner in People, "One person", as the runbook's step 5 says) and to put
  the people with no browser (the command-line helper, the socket reader, flow 7's made-up writers) on the member list in
  the database. A person with no invite is refused by the server itself (`restricted: not a relay member`), which the run
  checks first so it is not an open server in disguise.
- **What a visitor with no account gets on the invite-only server: the project's shared address does not open.** Flow 9
  opens `/p/<name>-<founder>` signed out. The page loads the app and shows one alert, **"Couldn't open this project."**
  with a "Try again" button, and the Sign in and Sign up buttons in the header. It says nothing of an invite, and
  "Try again" cannot help. The same address opens the scorecard for anyone signed in as a member, and for everyone on an
  open server (flow 9 checks both). So on the pilot's own setting **a founder who presses "Share" gives their followers a
  link that shows an error unless the follower already has an invite.** The server's refusal text for this case ("This server
  is invite-only. Open the invite link you were sent.", `web/src/shared/lib/refusal-text.ts`) is not what the page shows.
  The journey accepts this answer, the scorecard, or the invite-only words, and fails on a blank page or a dead end, so a fix
  changes nothing in the gate.
  - **Decision for you (STATUS.md, "Waiting on you" 5):** either say in words that shared links reach members only (the
    runbook now tells founders to share only with people they will invite) and show the invite-only sentence instead of the
    error; or allow public reads of a project's scorecard, which is a moderation and counsel question (D107,
    [HOLDER-ACCESS-MODEL.md](HOLDER-ACCESS-MODEL.md)). Nothing was weakened here. Share previews (a link pasted into a chat)
    have the same limit and are not built.
- **The owner's commands against the journey's own records.** `./run.sh founders` read the invite-only run's database: one
  founder's project with 4 weekly updates, 8 promises (2 kept, 2 missed, 1 changed, 2 never answered), 2 help requests, 3
  offers and 2 tasks, both accepted; the journey's own page totals say the same for tasks ("2 pieces of work accepted"). The
  made-up "Noise" project shows as a founder with no update, which is the journey's, not a bug. The command's own test
  (`scripts/test-pilot-commands.sh`) checks each number against seeded records and goes red under five mutations of the queries.

## Contributor run (and the later runs)

Sections C1 to C7 below are for the contributor run, with its work areas, reviewers and awards. Pilot A does not use them.

## C1. Each piece of work

One row per submission, including the ones turned down and the ones never reviewed.

| Work area | Name | Submitted | Accepted for review | Reviewer A: when, verdict | Reviewer B: when, verdict | Window over | Award vote: opened, passed | Shares awarded | Delivered? (founder's view, one line) |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

Where to read it: the Work tab (each claim's steps), the claim's story on Contributions (date, transaction, reviewers,
verified evidence), the Decisions tab (the award vote).

## C2. Review turnaround

From the table above:

- **Submission to accepted for review:** median …, longest …
- **Accepted to both verdicts:** median …, longest …
- **Approval to award vote passed:** median … (the 7-day window plus the vote's own time)
- **Never reviewed**, and why: …

A run where any piece waited more than three days for its first verdict needs its reviewers' terms looked at before the
next one.

## C3. Reviewer disagreements

- **Pieces where the two reviewers differed:** … of … Each one: what each said, and who was right in the founder's view
  and in the contributor's.
- **Turn-downs** and whether the person understood the reason without help: …
- **Resubmissions** after a turn-down, and how they ended: …

## C4. Awards against delivered work

- **Awarded and delivered:** …
- **Awarded but not really delivered** (the reviewers approved, the founder or a contributor disagrees): … each with what
  the work area's words said, which is where to fix it.
- **Delivered but not awarded** (approved, but the vote failed or never happened): … and why.
- **Shares awarded in all** against **what the founder holds**: … (who decides, today, is in the header).

## C5. Where people stopped

- Words someone asked about, copied exactly: …
- Every step someone needed help with, and what was said: …
- Every error message seen, and whether the person knew what to do next: …
- The answers to the runbook's questions, per person, marked right or wrong. Anything wrong is a page to fix.

## C6. Later, for funded projects only

Not for the contributor run: these need funding terms and weekly rounds, which the pilot build leaves out.

- **Net funding:** money funding rounds paid into the treasury, less what leaving took out over the same weeks.
- **Exits:** how many, how much, and the exit fee they left in the treasury.
- **Premiums:** each round's clearing price against what a unit took out of the treasury at the time, and how much bid
  money went unfilled. Show the treasury behind each unit first: a price made by a few trades, or by the team trading with
  itself, says little.
- **Holder rounds:** sellers matched with buyers instead of leaving, and how much the treasury kept that way.

## C7. What to change before the next run

One line each, in order of how much it got in people's way.
