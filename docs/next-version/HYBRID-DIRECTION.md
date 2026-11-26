# Creaton: a feed of backed projects, with take-out any day

Status: a note for the owner, not a plan, and nothing here is built. Written 26 November 2026 on branch `v6.5`. Money in the
sketches is play dollars on a test network. Nothing here is legal or tax advice. Sources: `docs/next-version/DIRECTION-REVIEW.md`
("the review"), `docs/next-version/MVP-V6-5.md`, and the files named. The app was not run for this note and the server code was
not read, so what the server accepts for project-tagged posts and room writes is unconfirmed.

## 1. The idea

The owner's ask: a hybrid of Fomo and MetaDAO that takes the best of each and is better than both.

- **From what the owner describes as Fomo's front door (not verified here):** a feed of projects and the people backing them,
  each with a short "why I backed this" note, and people you follow.
- **Behind that door, Creaton's own rules, which `v6.5` already has:** money held in the treasury, a capped allowance, a weekly
  check-in, and take-out by the backer alone with no vote. MetaDAO does not have the check-in or the no-vote take-out. What the
  review says MetaDAO is strong at is vetting and audience, and Creaton has neither.
- **Where Creaton may be stronger than MetaDAO:** for a backer who is watching, before any market opens, take-out needs no vote
  and no crowd. The review says Creaton is clearly weaker after a market opens, and its refund numbers are not yet reconciled
  with `v6.5` (decision 9). So say "may be stronger", not "beats both".

What a feed does not do: answer why a backer would put real money into a small project. The review calls that the fatal unknown
and says play dollars cannot answer it (gap 7, C9). A closed founder cohort (C0) tests only whether founders come and keep
posting. The first real evidence for backer demand would be a counsel-cleared real-money micro-pledge (C9), which is not decided.

## 2. What each does well and badly

| | Does well | Does badly |
|---|---|---|
| Fomo | Not sourced in the review. Per the owner: feed, follows, notes, friends-only, hide your own position. | Not sourced. "Chasing a coin's price" is the owner's reading, not a checked fact. |
| MetaDAO (reported) | Vetting and audience, the review's "real edge". | Decision markets drew a median of about 12 traders. Ranger's staff and vendors went unpaid after a forced return. |
| pump.fun (reported) | Speed. | 49.9% of graduations came in the first minute. Wallets with 100 or more launches made 40.1% of launches. |
| Creaton `v6.5` | Take-out is open whatever the door, allowance or state is (`pot/TakeOutSheet.tsx`). | No social layer around the money yet (section 3). Unaudited contracts; no Sepolia deploy; money journeys not run on this line. |

Fomo is mentioned in the repo only secondhand: `docs/v3-review/CREATE-BILLION-REVIEW.md` (about line 373, a private company, its
income figures company claims) and `docs/v3-review/PLAN.md` item 5 and decision D6. D6 already chose supporter lists ordered by
hold time and early backing on a launch's page, not by profit and loss.

## 3. What `v6.5` has, and what is missing

Found in the code; not run on this line (the money screens are covered by unit tests only).

**There:**
- Posts, comments, reposts, follow a person or a project (`features/posts/*`, `lib/follows.ts`). Home shows "Posts from people
  you follow" and "Projects you follow" (`home/HomePage.tsx`).
- Names instead of keys (`profile/ProfilePage.tsx`); report, hide, mute (`features/safety/*`).
- Per project, from the signed record: open to back, last check-in, check-ins in a row, the quiet state
  (`project/project-top-words.ts`, `money/numbers.ts`).
- Home sorts by money in exactly one place: "Money that stayed", which ranks money held over a whole window, then the number of
  accounts, then age, never a price or volume (`home/ranking.ts`, `HomePage.tsx` comment). Everything else on Home is not sorted
  by money. This sits close to the review's do-not-copy line "a board sorted by money" and is an open question for the owner
  (decision 10), not a settled fact.
- Notifications poll every 30 seconds (`notifications/use-notifications.ts`). An optional push card exists on You when the
  server has a push key (`YouPage.tsx`).
- A post can already carry a project tag (`buildComposedPost` in `packages/creaton-core/src/social/post-compose.ts`), and
  `UpdatesTab` pulls project-tagged posts in.

**Missing:**
- Backer notes. Nothing invites a backer to write one; the project tag is used only by the founder and team
  (`project/UpdatesTab.tsx`). `UpdatesTab` draws plain rows with no like or reply, so notes would need `PostCard` there.
- Proof of backing. A normal post can say "I backed this" with no proof. Only the holder Room checks Shares
  (`room/room-standing.ts`), its posts are hidden from Home, and writing there makes your wallet public.
- A backer's public record. "Your Backs and Take outs" is private and lives in this browser only (`pot/own-history.ts`). The
  record's holders list holds addresses and is cut at 200, so it must never be shown as a list.
- A "delivered" verdict. The nearest facts are the quiet state, the last check-in and tasks paid. The quiet state stays "Open"
  for two check-in periods, so "Open" must not be read as "healthy" (`pot/pot-words.ts`).
- Money facts on Home cards (`home/ProjectCard.tsx` reads no record; its people count is the team list, not backers).
- The "no check-in for N days" notice (`MVP-V6-5.md`, still-open list; the review's C4).
- Followers and following lists, and friends-only posts ("Posts are public").

## 4. Take, leave out

| Take | Why |
|---|---|
| "Why I backed" notes and follows | They reuse posts and follows. |
| Supporter lists ordered by hold time and early backing | Already decided (D6). |

| Leave out | Why |
|---|---|
| A leaderboard of backers by money | The review's do-not-copy list has "a board sorted by money". |
| Ranking backers by how many of their projects delivered | The review's C6 ranks projects, not people. This would be new, cheap to forge (accounts are free) and needs a "delivered" definition that does not exist. |
| Referral pay on volume | The review's rule is against "paying creators on volume"; referral pay has the same shape (judgement). |
| Decision markets for small projects | On the do-not-copy list; the repo chose rule-based exits. |
| Instant trading | The review rejects it (first-minute graduations above). |
| "Fair launch", "permissionless", "protected" in copy | The first two are banned by the review. Counsel question 7 on words like "protected" is unanswered. |

Hide-your-amount is not a feature `v6.5` has. Posts and the feed show no amounts, but each address's Share balance is in the
public signed record (`HolderNumbers` in `money/numbers-types.ts`) and on the network. Only the link between a person and an
address is private, until they link a wallet.

## 5. Sketches (phone width, plain words)

"[ ]" is a value to fill in. Tags say **exists** (the text matches the code), **changed** or **needs building**.

**(a) Back step, with an optional note** (the note is the only new part)

```
+----------------------------------+
| Back Tide Maps                   |
| You can take your money out any  |
| time. Nothing here promises a    |
| profit.                          |  exists
| You pay             [amount]     |  exists
| Fee to the platform, part of     |
| that                [fee]        |  exists
| You get             [N] Shares   |  exists
| Taking out now would give you    |
|                     [X] dollars  |  changed
|                                  |
| Why are you backing this?        |
| [ optional note             ]    |  needs building
|                                  |
| [Back]                           |
| The contracts behind these       |
| screens are new and have not     |
| been audited.                    |  exists
+----------------------------------+
```
The back step already has a "write in this project's room" box that makes the wallet public. Decide whether the note reuses that
box or is a second one (decision 3). Tie the take-out line to the live figure; do not ship the bare "any time" line until the
refund wording is reconciled (decision 9).

**(b) The "gone quiet" notice** (needs building; the one step that fits this line)

```
+----------------------------------+
| Tide Maps has gone quiet         |
| No check-in for [N] days.        |
| Last check-in: [date]            |
| Next one was due by: [date]      |
| Last written update: [date]      |
|                                  |
| You can take your money out.     |
| The take-out sheet shows what is |
| left behind.                     |
| [Read the last update]           |
| [Take my money out]              |
+----------------------------------+
```
"Due by" is in the record. A check-in can carry no written update, so show both dates. Do not say "nothing is lost": outside
money still arriving is left behind, and money set aside for a taken task comes back later as a claim.

**(c) Home card with a backer's note and money facts** (later; needs building)

```
+----------------------------------+
| Tide Maps                        |
| by Mara                          |
| Last check-in [date]             |
| Check-ins: [N] weeks in a row    |
| Why Jo backed this (you follow)  |
| "[their note]"                   |
| [Back] [Comments]                |
+----------------------------------+
```
Home has no money read today. It would need either `useRecentNumbers` (pages of 100 records, only where the server signs them) or
a per-project read like `alerts/use-news.ts`; the ranking's limit of 10 records does not carry over. Hide the figures when the
record is more than 24 hours old.

**(d) A backer's page** (later, opt-in; needs building). Show last check-in and the quiet state as two separate facts per project.
Do not total them as "still checking in x of y" until "delivered" is defined.

## 6. Build order, smallest first

0. **The closed founder cohort.** It needs a Sepolia deploy, a play-dollar token and a faucet (C0, C3 part 1), about 1 to 2
   weeks of builder time, then 2 to 4 weeks running. It tests founders, not backer demand.
1. **The quiet-project notice, in app only.** It needs the record's last check-in and due-by date for the projects the account
   holds (use the `YourSharesList` approach with `holdingHint`, a hint only because the holders list is cut at 200) and the
   alerts feature. **This is the only step that fits the `v6.5` line and the only one the review (C4) and `MVP-V6-5.md` both
   name as the cheapest protection. It may be all that ships for the cohort.** It reaches only people who open the app.
   Everything below widens the line and waits for the cohort to show people want it.
2. **Backer's note on the Updates tab,** drawn with `PostCard`, labelled "says they backed this", acceptable inside a closed
   cohort only. Note: a founder-only cohort has founders, so decide who writes notes.
3. **Money facts on Home cards.**
4. **A verified "backed this" label** (needs a linked wallet, which makes it public; decision 3).
5. **A backer page, opt-in.**
6. **A shelf of projects ranked by evidence** (the review's C6; gated on the first-500-backers plan and the same-device and
   self-paid exclusions, which are not built).

Not now: leaderboards by money, referral pay, decision markets, instant trading, friends-only posts, boards, down votes, followers
lists, the Council round, real-money pledges, email, turning push on by default, editing a note in place (an edit publishes the
new post first, then takes the old one down, and is offered only while nobody has commented).

## 7. Decisions for the owner

1. Do you accept that steps 2 to 6 wait on the cohort, or run beside it?
2. What counts as "delivered"? The record has check-ins, tasks paid and the quiet state, no verdict.
3. Public backing against privacy: a verified label or a backer page needs an opt-in public link between a person and a project.
   Allowed? And does the note reuse the existing room box at Back?
4. Is a labelled-unverified note good enough inside the closed cohort? A fake "I backed this" is possible today.
5. Accounts are free, so any ranking is forgeable until the same-device and self-paid exclusions exist.
6. Does an absent backer need email or push before real money?
7. Notes skew positive. The feed already shows backed and took-out at equal weight (`feed/ProjectFeed.tsx`); should notes get a
   "why I left" counterpart?
8. Counsel: what picking projects for a shelf means legally (review, question 8), and whether notes beside money read as promotion.
9. Reconcile the refund wording. The review's refund-falls-over-26-weeks numbers (gap 5) do not match `v6.5`'s take-out-at-current-
   value screens. Do not quote either until they agree.
10. "Money that stayed" is Home's one money-sorted list. Keep it, or remove it to match the review's do-not-copy line?
