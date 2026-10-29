# The milestone test (test network, no real money)

Milestone locks are the team side of a raise, and raises wait for the audit. Nobody has yet worked through one with a
real team, so before any money depends on them, one small team does, on Sepolia with test USDC. It is the third run in
[PILOT-RUNBOOK.md](PILOT-RUNBOOK.md); results go in [PILOT-REPORT.md](PILOT-REPORT.md). How a milestone is judged is in
[PILOT.md](PILOT.md) and `docs/milestone-challenge.md`: the team publishes evidence and a bond, holders can object, an
objection goes to a vote of holders in which the team's tokens do not count, and with no objection anyone finishes it.

## Who

A team of one or two founders, four to six backers who buy in the test sale, and one person on your side reachable within
the hour. At least two backers should not know the founders, so that judging the evidence is not a favour.

## The deliverables

Small, dated, and checkable by a stranger in five minutes from what the team publishes, with no access to the team. Write
each milestone's words exactly as below (adapted to the project) before the sale; the words are what holders judge.

1. **A public page.** "By <date>, a page at <URL> says what the project is, who is on the team by name, and how to reach
   them; it loads on a phone." (Day 3.)
2. **One working feature.** "By <date>, at <URL>, a visitor can <one action, such as sign up with an email address> and
   receives <a confirmation> within ten minutes. The evidence is the link and a recording under two minutes." (Day 7.)
3. **Outside use**, deliberately left short of its words. "By <date>, ten people outside the team have <done the action>;
   the evidence lists their first names and dates." The team publishes it with six. This is the one holders should turn
   down: the test is whether anyone notices, objects with a reason, and whether the vote goes their way.

Each milestone holds back a third of the team's tokens.

## The timing: short waits (decided 2026-10-29, D138)

The defaults are a week for objections, five days for a vote on one, and a month after each unlock for a late objection,
during which the next milestone cannot be published: three milestones would take about three months. The test uses short
waits instead, the same rules with less time: **1 day for objections, 1 day for a vote, 2 days for late objections**. On a
test network the launch panel has **Shorter waits, for a test on this test network** under "Holders can object": type
1, 1 and 2. (A bigger milestone waits longer, and a retry longer again, as with the usual waits.) A launch on a real
network never shows these fields and always uses the usual waits. The whole test takes about two weeks.

## The order

| Day (short windows) | What |
|---|---|
| 0 | The team launches with the three milestones and their words; the sale opens |
| 1 to 2 | Backers read the page, answer the runbook's raise questions 1, 2 and 6 out loud, bid, collect |
| 3 | The team publishes evidence for milestone 1 and posts the bond. Holders have a day to object |
| 4 | Nobody objects: anyone finishes it, the first third unlocks. Write down who noticed it on Home |
| 6 | The month for late objections (two days here) ends |
| 7 | Milestone 2 published; one backer is asked, privately, to object to it if anything in the evidence is missing |
| 8 to 9 | If objected to: the vote. Write down who voted, and whether they read the evidence first |
| 11 | Milestone 3 published short of its words |
| 12 to 13 | The objection and vote. A good result: it is turned down, the team understands why, and publishes it again later |
| 14 | One backer leaves with their share, and says what they got and why they left |

## What to measure (into the report)

- **Noticing:** for each milestone, whether each holder saw it without being told (Home's "waiting on you"), and when.
- **Judging:** whether holders could tell if the evidence matched the words; any objection's reason, and whether others
  agreed with it.
- **The vote:** turnout of what could vote, how long people took, and whether the result matched the evidence in your
  view.
- **The team:** whether they could write words a stranger could check, whether they understood the bond and when it can be
  taken, and what they did after a turn-down.
- **Leaving:** whether anyone left while a milestone waited, and whether they understood what they got.

## Before starting

**A separate test-raise build, decided later.** The test sale needs `VITE_DAO_LAUNCH_KITS`, and the hosted image does
not take it: the image in `deploy/compose` offers contributor projects only, on purpose. So this test needs a build of
its own, for example a static `pnpm build` in `web/` served on a separate address, or a test-network-only setting in the
image that `web/scripts/check-deploy-env.mjs` allows on Sepolia alone. Which one is a decision for later, before this
run; nothing is built for it now, and the contributor run does not need it.

It also needs the fundraising kit (deployed by the same broadcast as the contributor kit) and test USDC for every backer
(Circle's Sepolia faucet, or a funded account you hand it out from). Run `scripts/cli-milestone-e2e.sh` and
`scripts/web-milestone-e2e.sh` on the build you host first.
