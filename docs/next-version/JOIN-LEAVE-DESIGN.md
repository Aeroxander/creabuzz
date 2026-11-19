# Creaton: back fast, take out any day (design and build spec)

Status: a design. **Nothing in it is built yet. Building starts in the order of section 8 under the owner's standing go (keep working, no questions); the owner may overrule any choice in section 11 at any time.** First written 19 November
2026 on branch `v6`, after the owner's words of that day (join quickly, leave easily, one treasury, a daily allowance,
tasks with a notice window, founder and team Shares that vest and can leave). Revised the same day after three
independent reviews (an attack on the money rules, a check against the built code, a check against the owner's
direction); section 13 lists what was declined and why. It replaces the money rules of `docs/PLAN-V2.md` (section 9 says
what stays). Test network with play dollars first. Not legal or tax advice; legal points are questions for counsel
(section 12). No figure in this document is a promise or a forecast of any result for anyone.

How to read the numbers. **measured** = counted in the code or a report in this tree. **reported** = from a named page
read on 19 November 2026 (section 14). **simulated** = plain Python, assumptions stated, files in section 14; nothing was
run against contracts. **arithmetic** = worked by hand from the rules. **judgement** / **estimate** = my choice or guess.
**(C#)** = an open point I chose under the owner's standing go; the owner may overrule; section 11 lists each with its
alternative.

What this revision changed (each is argued below): the 2% "extra" in the price is gone, so nobody is paid for being early
and the Team can no longer take from later joiners; outside money arrives over 7 days and leaving is paid on what has
arrived, so a join, a payment and a leave in one block gains nothing; notes are keyed by a never-reused serial, not a slot;
the notice is 14 days plus 12 hours per 1%, and a second signer no longer lifts any limit; the founder picks two numbers,
not seven, and every day-count is a multiple of one time unit; forfeits wait 7 days and happen only by the member's own
exit or both signers; the app words are "Back" and "Take out"; the build list now includes project zero, the team budget,
the server and the test harness, and its cost doubled (13 engineer-weeks for step 1, not 6).

## 1. The model in five sentences

1. You back a project in two presses at the price the money in it sets that second (exactly what your slice would give
   you if you took it out now, plus nothing); there is no funding target, no deadline, no stage, and the only fee is 2%
   to Creaton on money going in.
2. All the money sits in one pot, and the team reaches it two ways only: a small daily allowance (a slice of what is
   left, so it shrinks as money leaves) and tasks, which are announced and wait at least 14 days before any money moves.
3. Any day, with one press, you take your slice of the pot out: no vote, no fee, nobody's say-so, so if you dislike a
   notice you take your share first.
4. The founder and team get their own Shares, which unlock over about two years of active work; once unlocked they can
   leave and be sold, but they claim only what is in the pot **above** what backers put in and have not taken back, so
   a free Share can never take a backer's money.
5. The page shows live what taking out would give you, with the line "This can go up or down. It is not a return." The
   legal line is quoted as it stands, "Buyers acquire ownership only: governance and exit. No dividends or revenue share,
   ever, unless they contribute and earn one." Whether this mechanism fits that line, with no vote and with outside money
   reaching the pot, is the first question for counsel (12.1, 12.4, 12.6).

### Three things to know before you say go

1. **Outside money raises what every backer can take out.** As designed (C17), a payment from a customer goes into the
   same pot, so it lifts the leave-value of everyone holding while it arrives. That is how the founder's Shares can be
   worth something, as you asked, and it is also the nearest thing in this design to a revenue share for buyers, which
   the legal line forbids. It is the one place this design may breach the line. The test network avoids the question;
   real money must not start until counsel rules (12.6). The alternative (C17) sends outside money to a separate bucket
   the team may spend under the same notice rules and that never touches what leavers get; it is cleaner and makes the
   founder's Shares worth almost nothing. Figures that show the pot rising are in 2.4 under a label saying so.
2. **There is no vote.** The line says buyers get "governance and exit". Here governance means the notice and the right to
   leave; nobody can vote on a task. If counsel says that is not governance, the choices are a holder veto on one task
   during its notice (a vote, easy to farm with free accounts) or a different line. I have not reworded the line.
3. **A backer who never looks can lose a lot** (about 15 of every 100 in 30 days if the founder uses every limit,
   simulated, 2.3). The protection is the notice, the caps and leaving, and all three depend on someone looking. Alerts
   are not built (section 8).

### What you asked for, and where it is

| Your words | The rule that delivers it | Where |
|---|---|---|
| "pumpfun speed" | Two presses and one wallet signature on play dollars (two signatures on real dollars); Shares arrive in the same press; no target, no window, no cap. Desktop or wallet browser first; a phone with no wallet browser comes later (step 3b). No time is promised: none is measured | 2.1, 8 |
| "ragequit/MolochDAO feature" | One press burns Shares for cash at a number shown first; no vote, no grace for your own money, no fee, no token choice | 2.2 |
| "no quick profits" | No price curve and no bonus for being early: every joiner pays what leaving would give, so the first and the thousandth joiner are equal (98.00 per 100 paid, simulated) | 2.1, 4 |
| "join quickly if it has potential, easily leave" | The Back and Take-out sheets are the same size and show the exact number before the press | 2.1, 2.2, 2.8 |
| "shouldn't carbon copy MetaDAO" | No minimum raise, no market vote, no scale-back; a personal exit instead of a crowd vote | 5 |
| "Umia, friend.tech: only the good parts" | Taken: allowance from a treasury contract, a holder room, social sign-in. Left: the price curve, fees both ways, points, live streams | 2.7, 5 |
| "dynamic, not too many set parameters" | The founder picks two numbers (allowance rate, team pool); one time unit (7 days) sets every day-count; about a dozen fixed money limits remain | 3 |
| "not set fundraising amounts" | A project holds what people keep in it; the page shows live what taking out gives | 2.1, 2.6 |
| "founder opens a task which needs funding" | Tasks are announced, noticed, then funded from the one pot when a worker takes them (narrowed: backers do not fund tasks one by one) | 2.3 |
| "a daily allowance from the ragequittable treasury" | A rate of the pot a day, founder-set up to 0.20%, default 0.10% | 2.3 |
| "the fake task mechanism" | 14 days plus 12 hours per 1% of the pot; leave first; the amount shrinks if people leave | 2.3 |
| "founder shares eventually ragequit the treasury" | **Partly:** vested Team Shares leave with a claim on the pot above what backers put in. With no outside money that claim is worth nothing (C8 shows the alternative with numbers) | 2.4 |
| "vesting 2 to 3 years, shorter, or by success" | 24 months of active time after a cliff of about 3 months. Success enters only through the claim rule; a revenue-based clock is not built because it can be washed (2.4) | 2.4 |
| "simple, fun, sustainable, ASAP, not too lite" | A smallest launchable version first (about 13 engineer-weeks, honestly counted), then tasks, then social | 8 |

**Where it is weak. Read this before saying go.**
- **Protection depends on attention (the worst remaining weakness).** A backer who never looks can lose 15.0 of every
  100 in 30 days to a founder who uses every limit (38.6 in 90, 62.3 in 180; simulated, 2.3). A backer who looks at least
  weekly always has at least 7 days to take out before any task money moves, and loses only the allowance while looking.
  The page shows notices; nothing reaches a backer who does not open the app until alerts exist (step 2 in-app, step 3
  push or email).
- **The founder's pitch is weak.** With no outside money the team's Shares are worth nothing, because they claim only
  what is above what backers put in. That keeps backers safe; many founders may refuse it (C8).
- **Someone who knows a payment is coming can still share it.** A person who joins before a known outside payment and
  stays 7 days shares it pro rata and takes part of what the earlier holders would have had (2.5). Not stopped.
- **Nothing here shows demand.** Free accounts and play dollars say nothing about whether real people will join.

## 2. The rules

Words used below. **Pot (P)**: cash that leavers can reach now. Not in it: the allowance box, money locked for a taken
task, outside money still arriving, platform fees owed. **Paid-in (A)**: what backers put in after the 2% and have not
taken back. **B**: backer Shares in hands. **G**: Team Shares counted, meaning the pool set at birth, vested or not,
minus any burned. **Z**: unvested Team Shares announced to burn (2.4). **Leave-value** of a backer Share,
`v = min(P,A)/B + max(0, P-A)/(B+G)`: backers are paid first up to paid-in, anything above is shared by backer Shares and
Team Shares. Of a Team Share, `u = max(0, P-A)/(B+G)`. **Quote value** `vq`: the same formula on the pot plus money locked
for tasks plus money still arriving, with `G-Z`; it is the number a joiner pays. In the app: "the project's money" for the
pot, "what you would get if you took out now" for leave-value.

### 2.1 Join (the app calls it Back)

1. **Price** `p = vq`, computed inside the join transaction after the allowance has moved out, never from a stored number
   (a day-old price against 0.25% a day hands a joiner 0.25 per 100, simulated earlier). There is no extra on top:
   the 2% extra of the first version paid earlier holders out of later joiners' money, which is a bonus for being early
   (first joiner +6.4 per 100 at 100 joins, +11.3 at 1,000, +16.4 at 10,000, simulated, v4_attacks.py section D) and
   shifted money to the Team (2.4). Dropped (C1). The founder does not set the price; a founder price under cash takes
   from holders (57 per 100 at 0.60 against 1.00, simulated earlier).
2. **Pay `a`.** Platform 2% comes off first. The rest `m = 0.98a` enters the pot; `n = m / p` Shares are minted, rounded
   down, so rounding dust stays in the pot.
3. **Paid-in credit** `A += min(m, n x A/B)`. When the pot is at or under paid-in the whole `m` counts as paid-in; when
   it is above, `n x A/B` counts and the rest buys a slice of the surplus, shared with Team Shares. With no extra, nothing
   is booked wrongly: 200 later joins of 500 into a first join of 10,000 with the whole Team pool vested and leaving leaves
   the Team with 0.0 and backers with 98.00 per 100 paid (simulated, section C; with the old 2% extra the Team took 1,257
   to 1,817 of 110,000, all of it from later joiners).
4. **First join** is at 0.01 a Share (100 a dollar). A small fixed virtual offset (1 dollar and 100 Shares) sits in the
   **quote only**, never in what a leaver is paid, and a mint that rounds to zero Shares is refused (the vault donation
   trick; reported defence, not simulated against contracts). Leavers are paid exactly from the stored numbers, so the
   offset cannot pay early leavers more than the last one (a run with the offset on: first and last leaver the same to
   9 decimals; with the offset in the leave price the last leaver was 0.135% under at pot 58,800, 13.5% under at pot
   588, simulated).
5. **Limits.** Minimum 1 dollar; no maximum, no per-account limit. The door is one switch the founder can flip (closing
   hurts nobody). It also shuts by rule after 14 days without a check-in, and when wound down.
6. **Presses and signatures.** Back, then Confirm on the sheet in 2.8. On play dollars the token is ours and carries a
   pay-and-call (ERC-1363 style `transferAndCall`), so the sheet is **one wallet signature**; on real dollars it is two
   (approve, then join) unless the dollar supports a permit. The built app has only an injected browser wallet; the
   passkey account with sponsored gas is not in this app yet, and no play-dollar token exists (measured, direction
   review). So step 1 is for desktop or a wallet browser; I make no speed claim, because none is measured. A new visitor
   on the test network: connect a wallet, a faucet drops 1,000 play dollars once, then the two presses (C24).

**Worked quote (arithmetic, simulated v4_attacks.py J).** Pot 83,500, paid-in 98,000, 9.8M backer and 10M Team Shares:
leave-value 0.008520. Pay 100: platform 2, 98 into the pot, 11,502 Shares; taking out at once gives 98.00. The earlier
holders' value changes by 0.0000.

**Existing holders never lose to a join.** The price is the quote value, so a join leaves it unchanged (it is a
mediant of the old level and itself). Fuzz of the revised rules in exact decimals: 1,000 seeds x 400 random operations
(joins, leaves, Team leaves, outside payments arriving, forfeits, vesting, takes, returns, part-paid accepts, note claims,
allowance), lowest ratio of quote value after to before on every non-spend step 1.000000000000000 for backers and Team,
dollars conserved to 1e-62, notes never above the money returned (simulated, v4_model.py). A bot search of 300 random runs
that may leave any time but join only after a payment is visible found no run that nets money: best -3.1 per 100 paid
(v4_search.py). Instant join-then-leave returns 98.00 per 100, at any size: a whale of 900,000 into 100,000 gets 882,000
and earlier holders change by 0.0000; a cycler of 1,000,000 pays only the 2% fee (simulated).

### 2.2 Leave (the app calls it Take out)

1. **Pay** `n x v` for backer Shares (`n x u` for vested Team Shares), cash, one asset. Leaving burns the Shares and cuts
   `A` in proportion (`A x (1 - n/B)`). One transaction, `minCash` guard, no fee, no vote, no wait on your own money. The
   Treasury burns the caller's own Shares directly, with no allowance step (a change to the token: 6).
2. **Not reachable by leaving:** unvested Team Shares; the allowance box (at most 7 days of allowance); money locked for
   a taken task (2.3c); money still arriving from outside (2.5); platform fees owed. The quote is exact: the contract
   settles the allowance and any expired task first, inside the leave.
3. **Exit note.** While a task is locked, a leaver is paid cash on the pot without it and gets a note of
   `n x (v_with_locked - v_cash)` dollars against that task. The note is keyed by the task's **never-reused 64-bit
   serial**, not by a slot. If the task is paid in full the note is void (the task never sets "returned", so nothing needs
   clearing). If part is paid, the worker is paid first and the rest comes back pro rata to notes and to stayers (a
   notes-first rule would move cost onto stayers by timing). Why serial: with notes kept per slot a note could outlive its
   task and be paid out of a later task's returned money; in the simulated attack a leaver claimed 6,000 of a later
   returned task and the honest holder's Shares fell from 36,000 to 30,000 (16.7%). With serials the same sequence pays 0
   (simulated, v4_attacks.py A). No new task can ever be at an old serial, and a stale Pair proposal naming a serial
   can only touch that one task.
4. **No fee on leaving.** A fee kept in the pot pays the last leaver a windfall (10% tax: first 0.90, last 1.52,
   simulated earlier); a 1% fee still paid the last leaver more than the first (0.99 against 1.0425 in the first version's model, simulated earlier) and "pieces pay the same" failed (C3).
5. **A run.** Leaving never changes what the others get. 200 holders leaving in random order with the pot spent down to
   60% of paid-in: first and last got the same per Share to the last digit, 0.006000 (simulated, v4_attacks.py I; the
   first version's run also matched to 18 decimals with the pot at paid-in and with outside money). The allowance is a rate of what is left, so it falls with the pot. There is no run brake (C9).
6. **Market floor.** Shares and Team Shares are plain tokens from day one (C10). The contract never reads a market
   price. A pool price below leave-value is closed by anyone buying and taking out (the pattern in the Nouns fork and
   the Tribe redemption, reported), so backer Shares should trade at no less than leave-value. Team Shares trade at
   their claim plus what a buyer thinks of the project. The page shows pool price and leave-value side by side.

**Worked leave (arithmetic).** Pot 120,000, paid-in 98,000, 9.8M backer and 10M Team Shares: a backer Share is worth
0.011111 if you leave (1,000,000 Shares leave with 11,111); a vested Team Share 0.001111 (1,000,000 leave with 1,111).

### 2.3 Spend: one pot, two doors

**Time unit.** One platform constant, **N = 7 days**, fixed when the contracts are deployed and never set by a founder.
On a test network it can be set shorter for demos. Every day-count below is a multiple of N.

**(a) The daily allowance.**
- **Size** is a rate of the pot a day, set by the founder from 0 to a fixed ceiling of 0.20%, default 0.10% (C4).
  `box += P x rate x active seconds / day`, then the box is cut to N (7 days) of accrual. It counts as already spent in
  every join and leave quote. Settled by every action; linear between settles (2.800 against 2.764 per 100 over 14 idle
  days at the ceiling, arithmetic).
- **Accrues only** inside the check-in window of 2N (14 days), counted from launch (a new project starts inside its
  window; the built Treasury starts at 0 and would shut the door until a first check-in); a lapse is never paid back.
  `settle()` runs **first** inside `checkIn`, `applyRate`, `setRate` and `draw`; otherwise a project that lapsed 60 days
  and then checked in would have the lapse counted as active time and pay 1.40% of the pot at once (arithmetic). A test
  binds the order. The check-in carries the hash of the signed weekly record; the AI manager flags an empty one beside it
  (advice, not authority).
- **Lowering the rate** is immediate; **raising** is public for N (7 days) first and shown in every quote.
- **Who draws:** the runner; with a Pair as runner every money call needs both signers (the old 500-in-7-days one-signer
  lane goes; either signer alone can still check in); and agents only inside their own RollingCap daily limits, drawn from
  the same box (finishes "agents counted in the weekly limit", listed, not built, in the M4 report).

| Pot | Day one at 0.10% | 30 days | First year | Day one at 0.20% | 30 days | First year |
|---|---|---|---|---|---|---|
| 10,000 | 10 | 296 | 3,059 | 20 | 583 | 5,184 |
| 100,000 | 100 | 2,957 | 30,593 | 200 | 5,829 | 51,844 |
| 1,000,000 | 1,000 | 29,569 | 305,930 | 2,000 | 58,292 | 518,443 |

Simulated. At 0.10% the pot halves in 693 days and is never empty; at 0.20% it halves in 346 days. A founder who only
draws the allowance takes 0.70%, 1.39%, 2.96% of the pot in 7, 14, 30 days (5.83% in 30 at the ceiling), then stops if
no check-in arrives. A fixed dollar allowance does reach zero (50 a day empties 10,000 in 200 days); a rate does not.

**(b) Tasks above the allowance.** Steps and limits:
1. **Announce** (runner, or both signers if a Pair): what-hash tied to the kind 47003 record, payee (named, or open: the
   first to take is the payee), a dollar maximum, a share of the pot. **Limits, the same for everyone:** at most 5% of the
   pot per task; money **taken** (not announced) at most 10% of the pot per rolling 28 days (4N), counted as the share of
   the pot at each take; at most 8 open tasks at once. A second signer does not lift any limit (C18); it is a control for
   the team's own safety, not a protection for backers (the earlier design let a second signer double the caps, and a
   puppet second signer made that worth nothing: 15.2 became 24.7 per 100 lost in 30 days). A larger spend is paid in
   parts over weeks, on purpose.
2. **Notice** is **14 days plus 12 hours per 1%** of the task (2N plus N/14 per 1%; a 5% task waits 16.5 days). The
   money stays in the pot and leavable; the page says "team plans X to Y on day D; take your share out first if you
   disagree", and (step 2) an in-app alert goes to every holder. Why 14: a weekly looker, in the worst phase (announced
   just after a look), has the notice minus 7 days left after the next look, which is at least 7.05 days at any size
   (the first version's 7-day floor left 15 hours for a 1.25% task split off eight times, arithmetic). A looker every 14
   days never misses a task (notice is over 14); every 21 days, 21 to 33%; every 30 days, 45 to 53% (arithmetic). The
   claim is "a backer who looks every 7 days always has at least a week", not "nobody is surprised".
3. **Take** (after notice, within N, or the task lapses and nothing has moved; only the named payee, or anyone if open, and then the first taker is recorded as
   `takenBy`). Only now does money move, **the smaller of the stated dollars and the stated share of the pot now**, from
   the pot to the task's bucket, so the worker sees a funded task before starting (`minAmount` guard). Example
   (arithmetic): a 4,000 task stated as 4% of a 100,000 pot, notice 16 days; if 20% of Shares left, 3,200 locks; if half
   left, 2,000 (not 5% and 8% of what is left). A task nobody takes costs nobody. There is nothing to cancel, so nothing
   to grief.
4. **Accept** by the runner or second signer: never the payee, never an agent (an agent cannot accept itself or a
   sibling), payee cannot be a signer. **Payment goes to `takenBy` only**, the address that took it on the chain; the app
   checks that this equals the pay-to address in the relay's record before it offers Accept, because the relay does not
   check the chain. A part payment pays the worker first (3, above). The AI manager's check note is shown beside it.
5. **Not accepted** by the deadline (fixed 2N, 14 days, after take), or rejected: anyone returns the money; it goes to
   holders and exit notes. Expiry is a bounded step inside join and leave, not an optional argument (no leaver can be
   underpaid by a missing id).
6. **In step 1** tasks stay as built (a runner `spend`) but paid from a box draw, so a task is limited to what the box
   holds (0.10% of a 100,000 pot is 100 a day, 700 stored at most); the app checks the box before it offers Accept and pay,
   and says so. Notice, caps and notes arrive in step 2.

**(c) Locked money and the exit note.** From take until accept, return or deadline, a task's money is out of the pot
for leavers, at most 14 days. The quote value counts it at face, so a joiner pays for work already funded and the sheet
shows both lines. The earlier fear was real (simulated, v4_attacks.py F): pot 100,000, founder with 30% of Shares, the other
70% leave during a 10% lock, task returned. Without notes the founder's Shares end worth 37,000 against 30,000 fair
(+7.0 per 100 of the pot, from nothing); with notes 30,000. A 50,000 joiner into a pot with 10% locked, leaving at once,
gets 98.0 per 100 if the task is returned and 91.5 if it is paid (the cost is shared by all); earlier holders end at 98,000
(returned) and 91,467 against 88,200 (paid), never below the no-joiner case.

**What a founder can take, worst case.** A backer who looks at least weekly: the allowance (1.4% a week at the ceiling),
nothing from tasks before a week's warning. Never looks (simulated, v4_attacks.py G, takes of two 5% tasks at the end of
each notice and again every 28 days, allowance on, nobody leaving):

| Sleeping backer loses of every 100 | 30 days | 90 days | 180 days |
|---|---|---|---|
| allowance 0.10% (default) plus tasks at their caps | 12.4 | 32.8 | 54.9 |
| allowance at the 0.20% ceiling plus tasks at their caps | 15.0 | 38.6 | 62.3 |
| tasks at their caps alone | 9.8 | 26.5 | 46.0 |
| the allowance alone at 0.20% | 5.8 | 16.5 | 30.3 |

That is the weak point, said plainly: the limits are the same for a 10,000 pot and a 10,000,000 one (a bigger pot is not
a safer one), and a puppet second signer changes nothing because no limit depends on it.

### 2.4 Founder and team Shares

- **What they are.** A second token (the same ShareToken code). At birth the founder sets a **team pool** of 0 to
  100,000,000 Team Shares (default 10,000,000, C8); all of it counts in `G` from day one, so vesting never moves a
  backer's number and a joiner's quote is the same before and after any vesting day (found in judging: counting only
  vested Shares moved a joiner's quote on every vesting day, simulated earlier). The page says "team side gets x% of anything above what
  backers paid in": 51% at 100,000 joined, 9% at 1,000,000, and it falls as backers join (arithmetic).
- **Grants.** The runner (or both signers) grants Team Shares from the pool to members. This replaces the built Give
  Shares, work pot and team budget (section 6).
- **Vesting.** Each grant vests linearly over 24 months (fixed) after a cliff of 13N (about 3 months), on **active time**
  only (inside the check-in window), so a quiet project stops vesting. The active-time counter is new (the built
  melting-floor counter is the only one that exists and goes). **A grant is lost only** by the member's own exit, or by
  both signers after a public notice of N (7 days); then the unvested part is announced to burn (`Z`), joiners are priced
  as if it had already burned, and it burns on day N. A member who leaves in good standing keeps the vested part plus a
  pro-rata part of the current period. A wind-down by choice keeps every contributor's accrued part; the quiet wind-down
  (2.6) burns only what is unvested. The earlier draft let the runner burn a contractor's grant on day 89 of the cliff by
  winding down, and let a second account recapture part of the value (simulated, v3 attack G); the notice and the
  both-signers rule close that. Hand-over trims the founder by the same rule (**changed**: the built trim works only
  before the old clock, keeps days served out of 365 and sends the cut to the work pot).
- **Leaving and selling.** Vested Team Shares leave in one press at `u` (2.2) or trade like any token. Their claim is
  only the surplus: backers are paid first, so a spent-down project pays the team nothing.

Backer leave-value per 100 paid (2 already off to the platform) at months 0, 6, 12, 24, 36, simulated
(v4_team.py), allowance 0.10% a day, nobody leaves, **no outside money**, the team cashes in everything the day it vests:

| Rule | Backer leave-value | Team took of 98,000 paid in |
|---|---|---|
| Plain: Team Shares claim pro rata, 36 months, team side 80% | 98.0 / 42.1 / 18.1 / 3.3 / 0.6 | 76,529 |
| **Chosen: claim above paid-in, 24 + 3 months** (either pool size) | 98.0 / 81.8 / 68.4 / 47.7 / 33.3 | 0 |
| No team Shares at all | 98.0 / 81.8 / 68.4 / 47.7 / 33.3 | 0 |

With no outside money the chosen rule costs backers nothing: the fall is the allowance, identical to a project with no
founder Shares, and later joiners cost the Team nothing either (2.1, step 3: 0.0 taken). **What a founder can take
through Shares: nothing of backers' paid-in money, ever; at most the team side's share of what is above it.** What they
can take through the allowance and tasks is 2.3. A wash test (simulated): a founder with every Team Share vested pays
10,000 of their own money in as "revenue", waits the 7 days, and gets back 8,000 (pool 4 times backer Shares) or 5,000
(equal): a net loss either way. That is why a revenue-based vesting clock is not built.

**What would happen if outside money arrived. This is the point counsel must rule on (12.6); it is not a forecast and
no promise.** Same run with 4,000 a month of outside money, arriving over 7 days each time (simulated, v4_team.py):

| Rule | Backer leave-value per 100 paid at months 0 / 6 / 12 / 24 / 36 | Team took (of 144,000 arrived) |
|---|---|---|
| Chosen, team side 80% | 98.0 / 99.2 / 100.7 / 105.9 / 114.2 | 12,333 (8.6%) |
| Chosen, team pool equal to backer Shares | 98.0 / 100.9 / 104.0 / 111.0 / 117.7 | 6,245 (4.3%) |
| No team Shares | 98.0 / 103.5 / 108.4 / 115.9 / 121.2 | 0 |

Values above 98 come from a revenue I chose, not a prediction. They show the mechanism: outside money lifts what every
holder can take out, which is exactly what counsel is asked about (and what a separate income bucket, C17, would avoid).

**What a Team Share is worth (the owner's wish, stated honestly).** Delivered only when the pot is above what backers
put in. Choices in C8: (a) the claim above paid-in, safe for backers, usually worth nothing before outside money; (b) a
small capped claim on principal that vests with active time: worth something, but it costs backers up to that cap of every
100 put in (arithmetic) and needs counsel. I chose (a) for the test network.

### 2.5 Outside money, and anything that would lift value in one step

Anything that lifts leave-value in one block can be sandwiched: join, event, take out. Three such steps exist, and each now
moves in the open and over time.
- **Outside payments** (`addRevenue`, anyone's call) go into an arriving bucket that releases to the pot evenly over N
  (7 days). A joiner pays it at face (it is in the quote value), so someone who joins after the payment is visible captures
  none of it; a leaver is paid on what has arrived, so the part still arriving stays for those who stay. The page says
  "x of outside money still arriving". Simulated (v4_attacks.py B), pot 98,000, bot joins as much as the pot just before a
  payment and takes out at once: **-2.00 per 100 paid** at every payment size from 10% to 50% of the pot (old rule, where
  the payment landed at once: +1.88 at 10%, +9.16 at 25%, +21.29 at 50%; a bot a tenth the pot's size +5.0, +18.1,
  +40.0).
- **A forfeit or wind-down burn** is announced N days ahead and priced into every join as if done (2.4). A bot that
  joins before the notice and takes out when it starts gets -2.00; one that joins during the notice and leaves at once
  loses far more (-16.38 per 100 in an extreme case with 60,000 of outside money and a 10M unvested pool). At 26N
  quiet days the door has been shut since day 14, so nobody can join into a wind-down; a person who buys on a market
  faces a 7-day public notice.
- **Released tasks** return money at face (the quote counts locks at face), so a return is no step.

**What it does not stop, and what does not work.** A person who knows a payment is coming (an insider, or someone who
sees the pending transaction), joins first and **stays the 7 days** shares it pro rata: joining with as much as the pot
before a payment of 10% of the pot nets +2.90 per 100 over the week and the earlier holder ends 4,900 below the 107,800
they would have had alone (half the 9,800 payment); +10.25 and -12,250 at 25%; +22.50 and -24,500 at 50% (simulated). It
is an ordinary holder's gain from joining early, and it is a question for counsel (12.5). A fix offered in review, to
give a leaver a note for the unreleased part, does not help: tested, it gives the same numbers as holding (the bot is
paid its share of the payment as it arrives), so I did not adopt it. **The price of the rule:** an honest holder who takes
out while money is still arriving gets less than face: on day 0 of a 10% payment 90.9 per 100 of face, 94.8 after 3
days; of a 25% payment 80.0 and 88.6 (simulated). The Take-out sheet says so in plain words (2.8).

### 2.6 Maturing

Nothing is a stage. What switches on is triggered by ratios and only adds a safeguard as money moves:
- notice grows with the ask (replaces fixed windows) and a spend is limited to 5% a task and 10% of the pot taken per 28
  days whatever the size of the pot;
- a raise of the allowance rate waits N; vesting and the allowance run only on active time;
- an **"Established"** badge on the page (display only, no money rule) when at least 60% of the money has been held 13N
  (91 days) or more, at least 10 different accounts hold, and the project has two signers; by money held, not head
  count, since accounts are free on a test network. It is a hint and can be faked at the cost of the 2% fee (free on
  play dollars);
- **quiet:** 14 days (2N) without a check-in stops the allowance and vesting and closes the door; 91 days (13N) the page
  says "dormant"; 182 days (26N) any holder can announce a wind-down (door shut, allowance stopped, open tasks returned,
  leaving open; unvested Team Shares burn after the N notice). A junk update every 14 days keeps money flowing (measured
  weakness of the built check-in); the answer is leaving, the notice and the manager's flag.
- **Market:** none built by Creaton in version one; anyone can open a pool. A platform pool comes after counsel and 90
  days of life, and needs no change to the leave rule (C14).
- **Worked (arithmetic):** a project with 100,000 joined of which 62,000 has sat 91 days or more, 12 accounts and two
  signers shows "Established"; at 58,000 it does not, and no rule changes either way.

### 2.7 Fun and social

Take from pump.fun and friend.tech: instant joining, a shareable page, a place to be, a live feed. Leave: the curve, fees
both ways, points, streams.
- **Page:** one link per project showing the pot, what taking out gives now, allowance used today, announced tasks with a
  countdown, last update, door, and Back (signed-out visitors connect first). A share card image with no amount and no
  gain figure. Banner on every page and sheet: "You can take your money out any time. Nothing here promises a profit."
  Under any live number: "This can go up or down. It is not a return."
- **Holder room:** anyone can read, current backers and vested Team holders can write; taking out makes you read-only after
  N. Perks are text set by the founder (early looks, non-money polls, names in release notes). The AI manager posts
  notices and task results. Text first, report and mute, a person who can act.
- **Live feed:** joins, takes-out (equal weight), tasks and countdowns, updates, with rounded amounts and no names; "net
  money in" beside joins, never volume.
- **Streaks:** weeks of updates, weeks held. No points, no airdrop, no ranking by price; Explore ranks by money held 30
  days or more, with the number of different accounts shown beside it as a hint. No money ties to live attention or
  streaming. The app pays no gas in step 1; when sponsored gas arrives (step 3b) it is limited per account per day
  (a server setting).
- **Worked (arithmetic):** project A has 60,000 held 30 days or more, project B took 80,000 yesterday: A ranks above B. The
  feed reads "3 joined and 1 took out in the last hour, net +1,200" with amounts rounded to the nearest 100 and no names.

### 2.8 The two sheets (what a stranger sees)

The owner's first test is "easily leave", so both sheets are written out; the screens, not the contracts, carry this test.
Words: "the project's money", "what you would get if you took out now"; no "pot", "paid-in", "note" or "Team Shares".
Both fit one phone screen; everything else sits behind one "Details" fold. Examples, not forecasts.

```
Back (the sheet before the press)                 Take out
  You put in            10.00                       You hold               1,020 Shares
  You get               1,020 Shares                Taking out now gives   9.80
  Taking out right now would give you  9.80         [ Take out ]
  [ Back ]                                          Details (only when they apply):
  Details: fee to Creaton 0.20 (2%) · the team       - Part of the money is set aside for a task for up
  may take up to 0.10% of the project's money a        to 14 days: you get 9.20 now and up to 0.60 more if
  day · money set aside for tasks: none · money        the task is not paid.
  from outside still arriving: none                  - Money from outside is still arriving (4 of 7 days
  You can take your money out any time.                left): taking out now leaves that part for those
  This can go up or down. It is not a return.          who stay.
```
Run the 30-second test (a stranger finds the sheet, reads it and presses) on the desktop build before calling step 1
done; the phone test waits for step 3b. The word "Join" already means "ask to join the team" in the app, so the money
action is "Back" (the box was already called the Back box) and the exit "Take out" (C22).

## 3. Every parameter

| Parameter | Kind | Value | Why |
|---|---|---|---|
| Allowance rate | founder sets | 0 to 0.20% of the pot a day, default 0.10%; raise waits N, lower at once | fits the project; shown in every quote |
| Team pool | founder sets, once | 0 to 100,000,000 Team Shares, default 10,000,000 | sets the team's slice of surplus only |
| Door, second signer, member grants, hand-over, wind-down | switches and actions, not numbers | open or closed; optional Pair | closing hurts nobody |
| **Time unit N** | one platform constant | 7 days (shorter on a test network) | every day-count below is a multiple |
| Box cap; take window; raise wait; forfeit and wind-down notice; arriving-money release; read-only wait | derived | N | one week |
| Check-in window; notice floor; task deadline | derived | 2N (14 days) | twice the weekly look |
| Notice per 1% of a task | derived | N/14 (12 hours) | the ask sets the wait |
| Rolling cap window | derived | 4N (28 days) | money taken, not announced |
| Vest cliff; "dormant"; badge hold | derived | 13N (91 days) | about three months |
| Wind-down wait | derived | 26N (182 days) | about six months |
| Allowance ceiling | fixed money limit | 0.20% a day | worst year 51.8 of 100 (simulated) |
| Task caps | fixed money limit | 5% a task; 10% of the pot taken per 28 days; 8 open; the same for everyone | the table in 2.3 |
| Platform fee | fixed money limit | 2% of money joining (contract ceiling 5%); nothing on leaving | the only fee |
| Opening price, minimum join, quote offset | fixed money limit | 0.01 a Share first join only; 1 dollar; 1 dollar and 100 Shares, quote only | dust and donation control |
| Vest length | fixed money limit | 24 months of active time (no longer a founder choice) | the owner's 2 to 3 years or shorter |
| Agent limits | fixed money limit | 25 dollars a day (built) and 1/1000 of the Team pool, drawn from the box | agents never add to the allowance |
| Price, allowance in dollars, notice for a task, locked amount, team side %, badge | emerges | from the pot and the rules | no person sets them |
| **Removed** | | stage caps 10,000 and 50,000 and the Solo, Backed, Team, Council, Open ladder; the 24-hour round, 12-hour lower window and scale-back; the 3 / 15 / 82 split and the 26-week (182-day) release; the personal refund and its 5% fee; the melting floor's 365-day release and its hand-back; the 100,000 auction minimum, 4 times bid cap, closing blocks, reserve sale and the 365-day no-market clock; the Council and HolderVote; Pair's 500 in 7 days and the 1% gift cap; the fixed 1,000,000,000 supply with its 250M / 200M / 200M / 150M slices, the Creaton 20M stake and the work pot; a founder-set price; the 2% extra; a second signer lifting caps; founder-set vest length, door-by-number, task deadline and agent limits | each was a fixed number, or a gate the pot now replaces |

**Count (arithmetic).** The first version had 7 founder settings and about 30 other fixed numbers. Now: 2 founder
numbers, 1 time unit with about a dozen day-counts all derived from it, and 11 fixed money limits (ceiling, task cap,
28-day cap, 8 slots, fee, opening price, minimum join, quote offset, vest length, agent dollars, agent share). The
founder sees: "set the allowance and the team pool; everything else follows from one week."

## 4. Attacks and what happens

| Attack | What happens | Number |
|---|---|---|
| Fake tasks to the founder's own wallets | Payee shown, 14+ days public, caps the same for everyone, leave first | Nobody watches: 2.3 table (15.0 in 30 days at the ceiling). Weekly looker: at least 7 days to leave |
| Split a big ask into small tasks | The 14-day floor holds for each; 28-day cap counted on money taken | eight 1.25% tasks wait 14.6 days; a weekly looker keeps 7.6 days (arithmetic) |
| Announce at day 0 and 30, take late then early | The cap counts money taken | 10% moves in any 28 days, not 19% (arithmetic) |
| Fake task locked, others leave, founder stays and rejects | Exit note pays leavers if returned | +7.0 per 100 of the pot without notes, +0.0 with (simulated) |
| Notes reused from an old slot | Notes keyed by never-reused serial | slot-keyed: honest holder 36,000 to 30,000; serial: 0 claimed (simulated) |
| Free Shares leave against backers' money | Claim only above paid-in | plain claim: team takes 76,529 of 98,000; chosen: 0 (simulated) |
| Team takes from later joiners | No extra is booked as surplus | 110,000 joined over 201 joins: Team takes 0.0, backers 98.00 per 100 (was 1,257 to 1,817) |
| Wash "revenue" to vest or claim | Costs the founder; there is no revenue clock | 10,000 in, 5,000 to 8,000 back (simulated) |
| Join just before a payout, leave right after | Payment arrives over 7 days, joiners pay it at face | -2.00 per 100 at every size (old rule up to +40.0) |
| Join before a known payout and stay | Not stopped; shares it pro rata | +2.90 per 100 over 7 days at 10% (simulated); question for counsel |
| Join before a forfeit or wind-down | 7-day notice; joiners priced as burned | -2.00 per 100; during the notice -16.38 in an extreme case (simulated) |
| Many accounts, wash volume | Nothing is per account; page ranks by money held 30 days; badge is a hint | 1,000 one-dollar loops cost 20, all the platform's; zero on play dollars (arithmetic) |
| A run | Same per Share whatever the order; allowance falls with the pot | spread 0; down to 60% of paid-in 0.006000 a Share (simulated) |
| A whale joins to block or drain | No votes to block; round trip costs 2.0 | 98.0 per 100, earlier holders +0.0000 (simulated) |
| Sniping at launch | No cheap Shares and no bonus for being early | first, middle and last of 1,000 joins all 98.00 per 100 (was first +11.3, simulated) |
| Quiet founder, junk updates | Stops at 14 days; junk keeps the rate running; manager flags | 1.39% after going quiet; 30.6% a year at 0.10% if nobody leaves (simulated) |
| Check-in written before settle | Settle runs first; a test binds the order | a 60-day lapse would otherwise pay 1.40% at once (arithmetic) |
| Donation trick, first depositor | Quote-only offset, zero-mint refusal | not simulated against contracts; test design only |
| Grief by join-and-leave to cancel a task | Nothing to cancel: amount shrinks | locked 3,200 not 4,000 if 20% left (arithmetic) |
| Stranger takes an open task and the runner pays someone else | Payment goes to `takenBy` only; the app checks the record | built into step 2 (2.3b) |

**What was attacked and held (simulated, in exact decimals):** 1,000 seeds x 400 operations with conservation to 1e-62 and
no per-Share value falling on any non-spend step; 300 runs of a bot that may leave any time but join only after a payment
is visible, best result -3.1 per 100 paid; a second account that inflates the pot before a take leaves the honest
holder's loss at exactly the task's share of their value (the pot-share rule is not amplified by flash money); leaving has
no block beyond the ones listed, and the only thing that can hold a leaver for up to 14 days is a lock, which turns into a
note.

**Breaks found across the reviews, and what happened.** Fixed here: a joiner priced before Team Shares vest: all granted
Shares count; splitting tasks: a 14-day floor and a cap on money taken; a lock windfall to stayers (7 to 14 per 100): lock
at take, exit note; a cancel-by-leaving grief: smaller-of rule; a fixed 0.01 "par" that is not what backers paid: real
paid-in `A`; an unbounded task loop: 8 slots and a bounded expiry; notes outliving a task: serial keys; the join-event-leave
sandwich: arriving money and notice; the 2% extra booked as surplus and an early-joiner bonus: dropped; a second signer
that a puppet can fill: no longer lifts anything. Dropped earlier: the heat premium, the run brake and the 90-day
hold-age ceiling (free to farm on play dollars), the 1% exit fee, the transfer gate, the 5% refund fee. **Remain:**
sleepers (2.3); an insider who joins before a payment and stays (2.5); the weak founder pitch (2.4); junk check-ins; free
accounts on the test network; the donation trick untested against contracts.

## 5. What we take and leave

One line each, only what the research confirmed (reported, 19 November 2026).
- **pump.fun:** take instant joining and a shareable launch (reported: nearly 30,000 tokens launched in one day, The Block,
  9 January 2026; not a record, a secondary summary of a Dune dashboard puts the all-time high at 71,735 on 23 January
  2025); leave the curve and live streams (suspended 25 November 2024 after abuse, reported).
- **MolochDAO (v2, and Baal):** take pro-rata leave, no vote-linked block, a delay before a spend, a spend that fails if too
  many leave; leave sponsor-and-vote delays (voting and grace of 7 days each are defaults the deployer sets, reported from
  the v2 code comments), the token-list caps (400 and 200 are Moloch v2 constants, not Baal), and any path that moves
  money out of leaving's reach (the minion attack, reported).
- **Juicebox:** take open pay-in with no cap and payouts limited per period; leave the cash-out tax curve (first leaver
  gets least, simulated 10%: 0.90 against 1.52). (An earlier line said its rules are fixed at deployment; Juicebox
  rulesets can be reconfigured, so that is dropped.)
- **friend.tech:** take social sign-in with an embedded wallet and a holder-only room; leave the curve, 10% each way (about
  20% round trip, reported), points, and the contracts handed to the null address on 8 September 2024 (reported).
- **Umia:** take a treasury contract with a monthly team allowance fixed at creation and gated bigger spends; leave
  hand-picked launches and a market vote as the only way out (no personal ragequit found; reported, 4pillars research and
  The Block, 5 October 2026: 6.11 million dollars raised at an 18 million dollar valuation). Evidence that the allowance
  works as a draw is thin.
- **MetaDAO:** take a monthly team budget (reported, cryptobriefing.com, 9 September 2026) and minimum-raise refunds as proof
  that refunds by code work (secondary pages only: alearesearch.substack.com, solanacompass.com; no official page found);
  leave the minimum raise, scale-back and thin decision markets (one reported vote: eight traders, 9,405 dollars, vote on
  2 October 2026, page published 18 October 2026) as the guard.
- **Nouns and Tribe:** the cases behind the market floor (a Nouns fork of September 2023 with buyers below book value; a
  December 2021 Tribe redemption at 1.07 FEI; reported). The Sudoswap case was dropped: the reported March 2026 story
  is about holders voting to liquidate, not a pool priced to leave-value.

## 6. Built code: kept, changed, dropped

Lines are non-blank, non-comment (measured by `loc.py`). New sizes are estimates.

| Contract | Now | Becomes | Note |
|---|---|---|---|
| Treasury | 506 | about 800 | keep buckets, check-in clock, fees owed, `_pull`/`_pay`, reentrancy guard; drop melting split, reserve sale, settled gates, `workPot`, `giveShares`, gift cap, `payTeam`/`teamBudget`/`teamPayable` (about 230); add pot, join, leave, box, arriving bucket, serial task queue with notes, caps on takes, forfeit queue, Team leave, active-time counter |
| Launcher | 636 | about 270 | birth with rate and pool, door, hand over, Pair, wind down; no caps, no auction, no stake; **keeps** the settings-hash commitment (`expectedSettingsHash`, the project-zero `launchHash`); platform constants (N, fee, ceiling, caps) live apart from the two founder numbers; `Launcher.windDown(key)` stays as the app's and Pair's target and forwards to the Treasury, which also lets anyone call it after 26N quiet |
| Vester | 164 | about 260 | per-grant clock, cliff, active time, notice-then-burn forfeit, a "protected" flag (project zero); the held-Shares role (`heldGrants`, `cancelHeld`) and the old `trimFounder` go |
| Pair | 78 | about 100 | drop the 500-in-7-days one-signer lane; both-signed money calls; `checkIn(bytes32)` either signer; new selectors for announce, take, accept, return, draw, rate, grant, forfeit |
| ShareToken | 78 | about 100 | two instances; the 1e9 `SUPPLY` constant and "no mint" go; Treasury-only mint and **burn of the caller's own Shares without an allowance** (new and security-relevant: a test binds that only `leave` by the holder can burn) |
| RollingCap | 25 | 25 | unchanged |
| Parts | 21 | about 25 | no Rounds clone; the `earlierCodeHash` it records changes with EarlierBackers |
| EarlierBackers | 322 | about 340 | **changed, step 4**: see below; parked until then |
| Interfaces | 84 | about 90 | `IRounds`, `ITreasuryRounds` and `ProjectAddresses` change |
| PlayDollar (test network only) | 0 | about 100 | open faucet with per-account limits, pay-and-call; a new contract |
| Rounds, Finisher, Pinned, LiquidityHolder, MinBid, FixedFeeController, HookSalt, PoolGuard | 293, 227, 117, 83, 34, 31, 22, 6 | not built | about 810 lines kept in git for a later market |

Contract code goes from 2,727 lines to about 2,100 (estimate), the 810 parked lines excluded from the second figure.
`DeployPlatform.s.sol` (124 lines, never broadcast: fee controller, auction factory, mined hook addresses, minimum bid,
Parts, Launcher) is rewritten.

**Project zero and the earlier backers (a real dependency, not "re-pointed").** The earlier backers' claim reads the
Vester's single plain grant, which releases evenly over 365 days from the market opening or a no-market declaration, never
faster, no cliff; the signed text, its fingerprint and the consent flow say so. It also reads `ProjectAddresses` (rounds,
finisher) and bars those as receivers, sends leftovers to the Treasury reserve, and is funded from the 150M backing slice
and the 200M founder slice through the Launcher (`_cut`, `nameEarlierBackers`, `ProjectZeroSplit`); the server's
earlier block reads `ProjectZeroSplit`. All of these go. Chosen (C21): on the test network project zero is born
**without** the earlier backers' claim (the contract stays built and parked, the earlier page hidden). Before any real money,
the earlier backers receive Team Shares from a separate earlier-backers pool, on a **protected grant** (365 days from
project zero's birth, in calendar time, no cliff, never forfeited or burned or paused), and project zero's own founder
slice becomes a normal Team pool granted by the same rules (the built "team budget" accrual over 730 days becomes the
grant clock). **That changes what the earlier backers hold:** a Team Share claims only the pot above what backers put in,
and the market opening is gone. The signed text names the old terms, so it needs a new text version offered again to every
backer, a new fingerprint and a new consent, and counsel (12.10). I will not build it before the gate (step 4: about 1.5
engineer-weeks plus counsel). Parts, EarlierBackers and the reader's earlier block move to "changed".

**Team budget, gifts and agents (all in the code the design rewrites).** Gone: `workPot`, `giveShares`, the 1%-in-30-days
gift cap, `payTeam`, `teamBudget`, `teamPayable`, and the reader's team-budget events and the helper's "never payTeam" pin.
Give Shares in the app (4 presses, M7) becomes **Grant Team Shares** from the pool, each grant on its own clock; the grant
size is bounded by the pool, which is bounded at birth, and Team Shares cannot take backers' money (2.4), so no gift cap
is needed. The agents' Share limit (`shareCap`, an absolute 1/1000 of the old 1,000,000,000 supply, meaningless with a
growing supply) becomes 1/1000 of the Team pool. The 15 TeamBudget tests are dropped and replaced by grant tests.

**Tests (measured, 588 functions in 52 files).** 40 of 52 files import a base that launches through the Launcher; only 6
(ForkFacts, ForkPick, MinedCost, RollingCap, ShareToken, Vester) do not. About 303 round, stage, auction, pool and finish
tests (51%) are parked; the 141 floor and exit tests are rewritten into about 70. Of the 144 others, **only RollingCap (5)
is untouched**: ShareToken (13), Vester (14) and Launcher (21) assert what changes and are rewritten, TeamBudget (15) goes
with the budget, and the 76 EarlierBackers, Fuzz and AttackEarlierReview tests all launch through the Rounds base and are
parked until step 4, then rebased onto a new base. About 140 are new (join, leave, serial notes, arriving money, notice,
caps on takes, forfeit, allowance, team claim) plus about 20 invariants and fuzz, using `RoundsInvariants` and the
v4 simulations as templates. Tests that must bind the production seam: (1) notes never exceed the money returned for a
serial, with the 8 open slots cycled 20 times; (2) a 60-day lapse then a check-in grows the box by no more than the time
inside the old window; (3) a run with the quote offset on pays first and last leaver the same to the unit; (4) announce,
take late, announce again at day 30, take early: the 28-day sum of takes never passes the cap; (5) a join, payment and
take-out in one block nets -2.00 per 100; (6) a forfeit's join price counts it as burned; (7) later joins give the Team
nothing; (8) a part-paid accept splits pro rata; (9) only the holder's own `leave` can burn; (10) dollars are conserved.

**Server (chain reader).** The 11 non-test files are 5,090 raw lines (blanks and comments in) and **4,290 code lines**
(measured by the code review); the helper adds about 2,393 code lines and the reader's own tests about 2,633 (their
`numbers_tests.rs` is built on worked rounds). Log source, scan, store, signing, holder lists, clock and treasury sums stay
(about 3,300 of 4,290, estimate). Dropped: the Rounds arms, receipts, bids and sale, the Rust copy of the refund formula
(`numbers.rs:859`), and the helper's Rounds calls, `RoundsSweepFees`, the four Finisher calls and `TreasuryRelease`.
Added: about 19 events (section 7), a new role for the Team token (the `Role` enum and event table are closed), a
redecoded `ProjectLaunched` (it carries finisher, rounds and the `Allocation` struct today), regenerated fixtures
(`anvil_logs.json`, `next-events.json`), and record version 2 (pot, paid-in, Shares in hands, leave-value, rate, box,
arriving money, announced tasks, vesting). Hand-copied contract numbers (the 1B supply, the 182-day release, the solo and
team caps, the check-in window, the refund fee, 500 and 3e15) are replaced by contract view calls. **The app's parser
returns null for any record version but 1** (`numbers.ts:235`), so Home, Project, Team, Tasks and Week would all go blank:
the parser changes in step 1. Relay task rules (`launch_update_authority.rs`, `task_takes.rs`) gain notice, take and serial
states, about 200 lines (estimate). The helper may return expired tasks (not a person's money) and still never leaves,
refunds or claims for a person.

**AI manager cost rules (M8).** They read Rounds and Finisher events that are going. "Free while the founder posts weekly"
and "the hosted allowance starts when the first round closes" key on a `RoundClosed` log with accepted above 0; the
platform cap sums `Settled` and `Refunded` fees from Rounds and `raised - afterFee` from the Finisher. Changed in step 1:
the gate keys on the project's first `Joined` event with money in it, and the cap reads the new fee event. On the test
network fees are play dollars, so the cap is zero and the manager stays off unless the operator sets a floor (the
existing operator ceiling, `BUZZ_MANAGER_MAX_CENTS_PER_90_DAYS`, only narrows). Chosen (C23): leave it off until the
operator sets a number; the number is a server setting, not a contract setting.

**App:** Back box becomes the Back sheet; Receipts (551 lines) becomes "your Shares and what taking out gives now"; new
Take-out and Allowance screens; AcceptAndPay becomes announce, wait, take, accept (keep `paid-journal`) and checks the
box (step 1) and `takenBy` (step 2) before offering Accept; the Pair confirm sheet (`describeProposal` names only six call
kinds) gets a terms sentence for every new call (announce: payee, dollar maximum, share, deadline), which is the look the
second signer relies on; `checkIn(bytes32)` changes in Treasury, Pair, the two app builders (`calls.ts:89`,
`team-calls.ts:153`) and the weekly flow order (record signed first, then check-in); OpenBacking, OpenRounds, StageLine,
stage text and the auction and market screens (market feature 1,413 lines) go behind a flag, not deleted. Home, wallet,
Team (Pair, hand over, take the seat, wind down), Tasks record flow, AgentCaps, manager and the brain stay. Not
stay: the record parser, Give Shares, the earlier page (parked), the anvil harness (`app/tests/anvil/*`, 1,854 lines; its
loop, oversubscribed and failed scenarios are rounds and auction), `scripts/m7-chain-loop.sh` and `team-copy.test.ts`
(it walks every ABI error and fails on one without words).

**What milestones 7 and 8 already give (their reports):** M7: Pair, hand over, take the seat, Give Shares, wind down,
launch on the network, the earlier backers' page, an anvil chain loop that drives rounds and the auction; its auction,
pool and hand-back screens are parked. M8: Tasks tab (post, take, hand in, accept paid by `Treasury.spend` or Pair), agent
daily limits, the AI manager and project brain, a real-server week script (49 checks, no money moves in it). The
working tree also holds uncommitted app changes by the engineers, not read for this document.

**Cost summary (engineer-weeks, estimate).** Kept as is: wallet, Home, Team flows, Tasks record flow, AgentCaps, manager,
brain, RollingCap, the reader's store and signing. Changed: Treasury, Launcher, Vester, Pair, ShareToken, Parts,
Interfaces, EarlierBackers, helper, reader tests, record parser, Give Shares, Receipts, Back box, Pair sheet, manager cost
rules, deploy script, anvil harness, task payee check. Dropped (parked in git): Rounds, Finisher and the pool and auction
set, their tests and screens. New: PlayDollar and faucet, the arriving bucket, the serial task queue, the active-time
counter, Take-out and Allowance screens, alerts. Totals in section 8: about 27.5 engineer-weeks, step 1 alone 13.

## 7. Contract interfaces (new or changed)

```
Treasury (pot):  dollar, shares (backer ShareToken), team (Team ShareToken), runner, pair, paidIn A, pot P, box,
                 locked (sum of open tasks), arriving D + releasedUntil, feesOwed, ratePpm, pendingRate/pendingAt,
                 lastSettle, lastCheckIn, activeSeconds, door, woundDown, burnQueue {amount, at}, nextSerial,
                 openCount (at most 8), takes[8] {at, shareBps},
                 task[serial] {what, payee, takenBy, maxDollars, shareBps, announcedAt, noticeEnd, state, locked,
                               stayerClaim, returnedPpm}          // serial = never-reused uint64
                 noteOf[serial][holder]
join(uint256 amount, uint256 minShares, address to) -> uint256 shares      // 2.1; reverts if door shut or zero mint
onTransferReceived(...)                    // play-dollar pay-and-call path: the same join in one signature
quoteBack(uint256 amount) view -> (shares, takeOutNow, lockedLine, arrivingLine)
leave(uint256 shares, uint256 minCash, address to) -> uint256 cash         // 2.2; burns caller's Shares; writes notes
leaveTeam(uint256 shares, uint256 minCash, address to) -> uint256 cash     // vested only, claim above paid-in
quoteTakeOut(address holder, uint256 shares) view -> (cashNow, noteIfReturned, arrivingLeftBehind)
settle()                                   // accrue box, release arriving money, expire tasks, quiet checks; FIRST step of
                                           //   every action below, including checkIn, applyRate, setRate and draw
checkIn(bytes32 recordHash)                // runner, or either Pair signer alone; carries the record hash
draw(address to, uint256 amount)           // box only; runner, both Pair signers, or an agent inside RollingCap
proposeRate(uint32 ppm) / applyRate()      // raise waits N; lowering is immediate through setRate
announceTask(bytes32 what, address payee, uint256 maxDollars, uint16 shareBps) -> uint64 serial
takeTask(uint64 serial, uint256 minAmount) // named payee, or anyone if open (then takenBy = caller); moves pot to bucket
acceptTask(uint64 serial, uint256 payDollars)  // runner or second signer; pays takenBy only; the rest returns pro rata
rejectTask(uint64 serial) / cancelTask(uint64 serial) / returnTask(uint64 serial)  // return: anyone after the deadline
claimNote(uint64 serial, address holder)   // reads returned share for that serial; a paid-in-full task has none
addRevenue(uint256 amount)                 // anyone; enters the arriving bucket, releases over N (was shareRevenue)
announceForfeit(address member) / executeForfeit(address member)  // own exit, or both signers; burns after N
windDown()                                 // runner by choice (keeps accrued grants); anyone after 26N quiet
Vester:  grant(address member, uint256 amount, bool protected) / vestedOf / claim / forfeit / forfeitAllUnvested
Pair:    bothSigned() view                 // true only while a confirmed proposal executes; Treasury reads it
Launcher.launch(Settings{ratePpm, teamPool}, expectedSettingsHash)         // birth; no stage, cap or auction
PlayDollar: faucet() / transferAndCall(address to, uint256 amount, bytes data)   // test network only
Events:  Joined(who, paid, shares, price) Left(who, shares, cash, note) TeamLeft AllowanceDrawn RateProposed RateSet
         TaskAnnounced TaskTaken TaskPaid TaskReturned NoteClaimed CheckedIn(hash) RevenueAdded RevenueReleased
         DoorSet ForfeitAnnounced Forfeited GrantMade WoundDown            // 19
```

Storage that matters for tests: `A`, `P`, `B`, `G` and the box never leave sync with token balances (an invariant);
`locked` equals open tasks' money less notes issued; the sum of claimable notes for a serial never exceeds the money
returned for that serial; an accepted task has no claimable note.

## 8. Build order, smallest first (estimates)

| # | Step | Eng-weeks | Calendar, two builders | Gives |
|---|---|---|---|---|
| 1a | Contracts and their tests: pot, join, leave, arriving money, Team Shares with vesting and leave, allowance with ceiling and box, check-in gate, quiet wind-down, trimmed Launcher, Vester, Pair, ShareToken, PlayDollar with faucet, invariants and fuzz, new test base, first broadcast | 5.5 | about 3 | sentences 1 to 4 on a chain |
| 1b | Deploy script, anvil harness, chain-loop script, error-copy test | 1.5 | about 1 | a loop that runs |
| 1c | Reader v2: 19 events, role, `ProjectLaunched` redecode, fixtures, helper, reader tests, record v2; manager cost keys | 3 | about 1.5 | the numbers the app reads |
| 1d | App: record parser, Back, Take out, Receipts, Allowance, project page, Grant Team Shares, Pair terms for the new calls, `checkIn(bytes32)`, the box check on Accept; tasks stay as built, paid from a box draw | 3 | about 1.5 | a playable test network on desktop |
| 2 | Task notice, take, accept, return, exit notes, relay rules, `takenBy` check, app screens, in-app alerts to every holder | 5.5 | about 3 | the fake-task protection |
| 3a | Holder room, feed, streaks, share card, Established badge | 3 | about 1.5 | fun and social |
| 3b | Phone with no wallet browser (passkey account and sponsored gas; the direction review measured 2,469 lines of the old path); push or email alerts | 4.5 | about 2.5 | the phone, the alert |
| 4 | Gate before real money: outside audit, counsel (12), project zero's earlier backers re-pointed with a new text (1.5), Uniswap licence if a pool returns | 1.5 + n/a | n/a | the gate |

About 27.5 engineer-weeks, about 14 calendar weeks (estimate); step 1 alone (13) is a launchable test network, about 7
calendar weeks. The first version of this plan said 6 for step 1; the reviews found the rest (test base, server, harness,
project zero, deploy). The order inside step 1 is contracts and invariant tests first, then reader, then app. Step 1 ships
no locks, so the exit note and notice stay off until step 2, which turns them on together. The test network cannot
answer whether real people will join. Uniswap v4's licence is reported as BUSL until 15 June 2027 with the later licence
unclear (support.uniswap.org); it matters only if a pool returns.

## 9. What this replaces in `docs/PLAN-V2.md`

- **Replaced:** section 1 points 2 to 4 and the stage ladder; sections 2 and 3 (five stages, Longest wait); section 4
  (backing round, graduation, the auction, "fixes" for rounds); section 5 fees (3% of raises, 5% hand-back, 2% of Shares
  taken only if a market opens: now 2% of joins only); sections 6 and 7 where they describe Rounds, caps, the refund and the
  auction; section 11 decisions 1 to 4; **milestone 9** (HolderVote, Council, reserve sale) is not built, and its
  progressive-decentralization requirement has nothing to vote on (a point for counsel, 12.4); milestone 10's "fees show
  as CREATE's floor" needs rethinking, since the platform's only fee is now 2% of joins.
- **Stays:** the product idea and the legal line (quoted word for word; whether the mechanism fits it is a question for
  counsel); section 8 server and records (version 2); section 10 (off until an outside audit and counsel); milestones 5, 6,
  7 (Team part) and 8 as built; Creaton as an ordinary backer of other projects; seasons and demo day (milestone 10).
- **Changed:** project zero and the earlier backers' claim (section 6: new terms, counsel, a new text).
- **Open:** how project zero's manager powers end in a world with no votes (their caps now bound them: allowance ceiling,
  task caps, notice); counsel to review.

## 10. Platform income

One fee, in plain sight: 2% of money joining, taken at the moment of joining; nothing on taking out, the allowance, tasks
or trading. 2,000 per 100,000 joined (arithmetic); 20,000 if 100 projects each take in 10,000 (a scenario, not a forecast).
On the test network it is zero. An instant in-and-out costs 2.00 per 100, against about 20% round trip on friend.tech
(reported). **A conflict, disclosed:** the platform takes fees on churn (cycling 1,000,000 pays it 20,000, which is all the
cycler loses, simulated), so the app shows net money in, never volume. Rankings and the badge cost about 2% to fake and
nothing on play dollars, so both are hints, not rules. Dropped: the 5% refund fee, the 3% of raises, the unbuilt "paid
tasks 2.5% on top", the 20M platform stake. Optional later, after counsel: a platform Team grant.

## 11. Choices made under the owner's standing go, each with the alternative

Chosen under the owner's standing go; the owner may overrule any.

| # | Choice | Alternative |
|---|---|---|
| C1 | The rule sets the price (leave-value at face, no extra); the founder cannot | The 2% extra of the first version (early joiner +6.4 per 100 at 100 joins, +11.3 at 1,000, +16.4 at 10,000; a payment from newer money to older holders, which counsel may read as a different kind of fee; Team took 1,257 to 1,817 of later joins); a founder-set price (took 57 per 100) |
| C2 | One token for backers, a second token for the team's pool | One token for all, claiming pro rata (backers hold 0.6 per 100 at month 36) |
| C3 | 2% to the platform on joins only, no exit fee | A 1% exit fee (pays the last leaver); no fee at all (nothing for the platform) |
| C4 | Allowance ceiling 0.20%, default 0.10%, box N, raise waits N | Lower ceiling (0.10%); dollar-based allowance (reaches zero) |
| C5 | Tasks wait 14 days plus 12 hours per 1%; AI work needing speed uses the allowance and agent limits | 7 days plus 12 per 1% (leaves a weekly looker 15 hours after a split); notice charged on all tasks announced in the last week (more state, no more margin than the floor gives) |
| C6 | Money moves at take, locked at most 14 days, exit notes for leavers, keyed by serial | Lock at funding (worker-less locks); no notes (7.0 per 100 windfall) |
| C7 | Locked amount is the smaller of dollars and share of the pot | Cancel if a fifth of Shares left (a free grief) |
| C8 | Team pool default 10,000,000, 24 months fixed, cliff 13N, claim only above paid-in (usually worth nothing before outside money) | **First:** a small capped claim on principal vesting with active time (worth something, costs backers up to the cap, needs counsel); success-based vesting (washable: 10,000 in, 5,000 to 8,000 back) |
| C9 | No run brake, no hold-age ceiling, no heat term | Any of them (free to abuse on play dollars; heat term is a curve) |
| C10 | Shares and Team Shares transferable from day one | A transfer gate (farmable on a test network) |
| C11 | Quiet: 14 / 91 / 182 days; any holder winds down at 182; **no vote** | A holder veto on one task during its notice (a vote, farmable with free accounts); a different legal line |
| C12 | Test network with play dollars, a 1,000 faucet once per account | Real money first (no) |
| C13 | The built Pair, runner seat, agent limits and manager stay; the Pair's one-signer lane goes | Rebuild (no reason) |
| C14 | No platform pool, no auction in version one; Rounds and Finisher code parked | Keep the auction for large raises (Council needed) |
| C15 | "Established" badge and rankings are display only | A badge that unlocks powers (farmable) |
| C16 | Build the smallest launchable version first, honestly costed | All at once |
| C17 | Outside money enters the pot through a 7-day arriving bucket (test network only until counsel rules); leavers are paid on what has arrived | **A separate income bucket the team spends under the notice rules, never touching what leavers get** (cleaner legally; the Team's Shares then pay almost nothing); a note on the unreleased part (tested: no protection) |
| C18 | A second signer does not lift any limit; limits are the same for everyone | Second signer doubles caps (a puppet makes it worthless: 15.2 became 24.7 per 100 in 30 days); a second signer must have held backer Shares 30 days |
| C19 | A grant is lost only by the member's own exit or both signers with a 7-day notice; a good leaver keeps what has accrued | The runner alone forfeits (a contractor lost a whole grant at month 2.9 of the cliff) |
| C20 | One time unit N = 7 days; the founder sets two numbers | Seven founder settings (the first version) |
| C21 | Project zero is born without the earlier backers' claim on the test network; before real money they get protected Team grants under a new text, with counsel | Keep the old terms by keeping the old contracts (parked code, a second launch path) |
| C22 | The app words are "Back" and "Take out" | "Join" and "Leave" (collides with "ask to join the team") |
| C23 | The AI manager stays off on the test network until the operator sets a floor; the gate keys on the first join | A fixed hosted allowance paid by Creaton (a cost with no income) |
| C24 | One signature on play dollars through pay-and-call; the phone path later (step 3b) | Put the phone path in step 1 (about 3 more engineer-weeks) |
| C25 | Alerts: in-app in step 2, push or email in step 3b; until then the page shows notices only | Say nothing (the protection claim would be false) |

## 12. Questions for counsel (not answers)

1. Does a pro-rata cash claim on a shared pot, open any day, change how the Shares are treated, with the legal line quoted as it stands?
2. Is a Team Share that can leave with money above what backers paid in a revenue share to the team (allowed for
   contributors under the line), pay, or another kind of interest?
3. Does taking 2% of money joining make Creaton a seller of an investment in some places?
4. The line says buyers get "governance and exit". Here governance is the notice and the right to leave, with no vote. Is
   an allowance plus noticed tasks, with no vote, acceptable disclosure for a team spending backers' money, and does the
   line still read true?
5. Is an insider who knows outside revenue is coming and joins first, then stays, a problem, and what notice or rule
   should stop it (the 7-day arriving bucket stops only the quick sandwich)?
6. **Does money rising in the pot when outside payments arrive behave like a revenue share to buyers?** (The built
   Treasury already does this; C17 offers a separate income bucket instead.)
7. Does leaving by burning Shares change what a buyer acquires, and what must the page say?
8. Does a test network with play dollars avoid all of this for now, and what changes at the first real-money launch?
9. Which countries or buyers should the door stay shut to, and what may the platform host or moderate?
10. Earlier backers: may their signed terms (365 days from a market opening, ordinary Shares) be replaced by a Team grant
    that claims only above what backers put in, with a new text, a new fingerprint and a new consent?

## 13. Objections considered

Each finding from the three reviews was either fixed above or declined here with a reason.
- **Note on the unreleased part of an outside payment** (review of the attack): not adopted. Tested: a leaver paid a note
  for its share of a payment that arrives later gets the same result as a holder who stays (+2.90 per 100 at a 10%
  payment), so it does not stop a join-before-payment. The arriving bucket with a leaver paid on what has arrived is what
  kills the quick sandwich; the cost to honest leavers is stated in 2.5.
- **Credit the extra as paid-in** (review of the attack): moot. The extra is dropped (C1), so nothing is booked wrongly;
  checked: the Team takes 0.0 of later joiners. The review's formula would have fixed the extra's booking but left the
  early-joiner bonus.
- **Charge the notice on all tasks announced in the last 7 days:** not adopted; the 14-day floor gives the weekly looker
  7 days without more state.
- **A holder veto on one task, or a vote** (review of direction): not adopted; farmable with free accounts and a whale
  could block. Leaving is the veto. Offered as C11's alternative.
- **A task cannot be taken while the pot fell more than 10% in the last 7 days** (replacing exit notes): not adopted; it
  blocks honest tasks after a run and still leaves the lock windfall. Plain wording on the sheet instead (2.8).
- **Cap what an early holder gains from the extra:** moot, the extra is gone.
- **Stale Pair proposals never expire** (measured weakness in M4): not changed here. Serial keys mean a stale proposal can
  touch only the one task it names; an expiry is a separate Pair change.
- **Reviewers' "checked and found correct" items** (contract line counts, 588 tests in 52 files, 303 and 141, the M7 and
  M8 summaries, kind 39009, the quoted legal line, outside claims on pump.fun, friend.tech, Umia, Nouns, Tribe, Moloch
  attack note): no change needed.
- **Part-paid accept and notes-first:** adopted as pro rata, not declined; recorded in 2.2.
- **Rate-limit the gas the app pays:** adopted as a server setting in step 3b; in step 1 the app pays none.

## 14. Sources

**In this tree:** `docs/PLAN-V2.md`; `docs/next-version/PLANV2-M4-REPORT.md`, `PLANV2-M7-REPORT.md`,
`PLANV2-M8-REPORT.md`, `DIRECTION-REVIEW.md`, `EARLIER-BACKERS.md`; `contracts/next/src/*.sol` (line counts by `loc.py`, test
families by `fam.py`); `crates/buzz-relay/src/handlers/launch_update_authority.rs`, `task_takes.rs`,
`api/manager/cost.rs`; `crates/buzz-relay/src/chain_reader/`; `app/src/features/`.
**Simulations** (none in the repo), all under `/tmp/claude-0/-home-user-creabuzz/760bbfe4-cd00-52d2-a0ba-d5904ad4bed9/scratchpad/v3/`:
the revised rules are `v4_model.py` (exact-decimal model and the 1,000-seed fuzz, output `v4_fuzz_output.txt`),
`v4_attacks.py` (output `v4_attacks_output.txt`: serial notes, outside-payment sandwiches, forfeit, Team and later joins,
early joiners, round trips, locks, sleeper and looker tables, offset run, worked quotes), `v4_team.py` (output
`v4_team_output.txt`) and `v4_search.py` (output `v4_search_output.txt`). The first version's and the reviews' files
are `final_sim.py`, `adv_core.py`, `adv_fuzz.py`, `adv_attacks.py`, `adv_misc.py`, `adv_fix_check.py`, `adv_search.py`,
`review_check.py`, and the earlier rounds `joinprice.py`, `leavers.py`, `allow.py`, `oneRule.py`, `d1v3_vest.py`,
`d1v3_attacks.py`, `j1_attacks.py`, `j3_lockjoin.py`. Figures marked "old rule" are the first version's rules rerun in
`v4_model.py` with the extra switched on; the review's run gave +1,920 on the one case where mine gives +1,880.
**Reported (read 19 November 2026; summaries where a page refused):** Moloch v2 (github.com/MolochVentures/moloch, code
comments and constants) and Baal (raw.githubusercontent.com/HausDAO/Baal/main/contracts/Baal.sol;
baal-docs.vercel.app/features/ragequit); minion attack (hackmd.io/@heavychain/r137bazmD); Nouns fork (decrypt.co/197400);
Tribe (newsletter.tally.xyz, issue 57); Juicebox (juice-docs.vercel.app/user/tokenomics) and the Revnet whitepaper; Party
Protocol audit (code4rena.com/reports/2023-05-party); Umia (research.4pillars.io, theblock.co 5 October 2026); MetaDAO
(cryptobriefing.com/metadao-onchain-treasury-post-token-sale, 9 September 2026; pro.edgex.exchange, published 18 October
2026 about a vote on 2 October; refunds on secondary pages alearesearch.substack.com and solanacompass.com); friend.tech
(theblock.co, 20 September 2023 and September 2024; dlnews.com; thedefiant.io guide); pump.fun (theblock.co, livestreams and
9 January 2026 fees and launches); Uniswap v4 licence (support.uniswap.org, reported BUSL until 15 June 2027).
