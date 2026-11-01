# Pilot test guide

The hand tests to run before and during the pilot, in order. Each step points at its section of
[TEST-STEPS.md](TEST-STEPS.md) (a log in date order: use the section id, such as **4ce**) or at
[PILOT-RUNBOOK.md](PILOT-RUNBOOK.md), which says how to run the pilot itself. The pilot is the hosted build:
contributor projects only, no sale (D137, D140). Everything in TEST-STEPS.md about raises, markets or the optional
test-network features is not part of it (listed at the end).

Agents run the automated checks; the repository's rule is that a person then tests the change too. A step passes when
it does what the section says, with nobody explaining the screen.

## 1. On your machine, before anything is hosted

| # | What | Where |
|---|---|---|
| 1 | The pilot's journeys, green: `scripts/mvp-gate.sh --pilot` (needs Postgres, Redis, MinIO and foundry; about an hour). It includes a holder who is muted, then banned, keeping their rights, and a passkey sign-up and sign-in again on a real server (`scripts/web-restricted-holder-e2e.sh`). The contributor journey is not yet run as the hosted image builds it (`PILOT_BUILD=1 scripts/web-contributor-e2e.sh` exists, but its spec does not handle that build yet). A CI job for it is written but not pushed: publishing it is your call | [STATUS.md](STATUS.md), "The gates"; [MVP-GATE-CI.md](MVP-GATE-CI.md) |
| 2 | Every screen as the pilot sees it: `WEB_FEATURES=mvp scripts/web-screen-audit.sh`, then read the pictures. It fails on a stop that never reached its state or on two equal pictures | **4be**, **4ck** |
| 3 | The Sepolia deploy, rehearsed on a fork: `scripts/sepolia-deploy.sh` | **4al**, runbook "Before it" step 1 |
| 4 | The contributor journey on a fork with passkey accounts: `scripts/web-passkey-contributor-e2e.sh` | **4ce** |

## 2. On the hosted server, before inviting anyone

| # | What | Where |
|---|---|---|
| 5 | First start: secrets, the owner's key, signing in as the owner, terms at sign-up | **4bd** steps 1 and 2; runbook step 3 |
| 6 | Your real backup, copied off the machine, restored on another machine with the deployment's commands, and checked: posts, pictures, policies, identity, members, git data, then new data. `scripts/test-compose-backup.sh` is separate: it tests a scratch stack, not your backup | [RESTORE-REHEARSAL.md](RESTORE-REHEARSAL.md); **4bd** step 4 |
| 7 | The image is contributor-only: no sale anywhere (`/launchpad` and `/launchpad?start=sale` lead to Discover), Testnet tag on a phone, terms and privacy in the profile menu | **4cf**, **4ck** step 1 |
| 8 | Invite links: one per person, a second use refused, no way in without one | **4bd** step 3; runbook step 5 |
| 9 | Pictures: a profile picture, a board post picture and a project cover show for another member on another device | **4ch** step 1; runbook step 4 |
| 10 | Error reports reach your collector | **4n** (by hand); runbook step 8 |
| 11 | Passkey sign-in on a phone and a laptop; a lost device, then the recovery key; a synced passkey finds the same account. A journey signs up and signs in again with a virtual passkey on a local real server (step 1); real devices, recovery and a synced passkey are only checked here | **4ce** step 6; runbook steps 3 and 7; [MVP-GATE-CI.md](MVP-GATE-CI.md), "Not covered" |
| 12 | "Show your name with this account" from a new passkey account, and that name in the founder's reviewer picker | **4ce** step 2; runbook step 6 |
| 13 | A practice project from a passkey account, with one reviewer approving from a passkey account | **4ce** steps 1 to 5; runbook steps 3 and 10 |
| 14 | A turn-down closed by anyone; submitting again under a used name refused; leaving with an empty treasury needs the tick | **4cj** |
| 15 | Money sent out of a passkey account | **4cg** |
| 16 | "Your work" on the hosted server, as a contributor after the practice project's award: the awarded piece is there. `scripts/web-passkey-contributor-e2e.sh` opens it from the navigation and finds the awarded Shares, but against a stubbed server; no journey reads it from a real one | [MVP-GATE-CI.md](MVP-GATE-CI.md), "Not covered" |
| 17 | A holder whose access is restricted still reaches their evidence and rights: the five-step hand test. Steps 1 to 3 for a browser-wallet holder are automated (step 1); the copy-and-hash part of step 3, the passkey-account holder (step 4) and "nothing leaked" (step 5) are only checked here | [HOLDER-ACCESS-MODEL.md](HOLDER-ACCESS-MODEL.md), "Automated" |

## 3. During the social run (an hour)

| # | What | Where |
|---|---|---|
| 18 | Each person's six steps, on their own device, thinking aloud | runbook, "First: the social run" |
| 19 | Removals reach their author; reports reach a board's moderators; mute applies everywhere | **4ch** steps 2 to 4, **4ci** |

## 4. During the contributor run (about fifteen days)

| # | What | Where |
|---|---|---|
| 20 | The day-by-day plan, with your messages to each person | runbook, "The fifteen days" |
| 21 | Each day: the error collector and the ZeroDev project's spending (a `sponsor-refused` note stops everyone) | runbook step 8 |
| 22 | The planted turn-down, found by its contributor without help | runbook, after the table; **4cj** step 1 |
| 23 | The questions afterwards, and the report | runbook, "Ask each contributor afterwards"; [PILOT-REPORT.md](PILOT-REPORT.md) |

## Not part of the pilot

Raises, sales, markets and milestone locks (**4a** to **4c**, **4h**, **4j**, **4m**, **4t**, **4x**'s raise story,
**4z** to **4ab**), starting from a Projects-board pitch (the first part of **4ak**; its suggested work is in the pilot), and the test-network features that are off in the hosted
build: bounties, forecasts, CREATE and the court, money forecasts (removed from the app in D150), payouts, remixes, pledges, weekly
rounds and funding terms (**4bi** to **4cd**). The milestone test has its own plan
([MILESTONE-TEST-PLAN.md](MILESTONE-TEST-PLAN.md)) and a build of its own.

**Reading TEST-STEPS.md:** it is a log, so later sections can change what earlier ones say; when two disagree, the later
one holds. The ids **4ai** and **4aj** each appear twice (the second pair is D71 and D83), and sections **5** and **6**
sit between **4t** and **4u**. Test counts quoted in a section are as of its date.
