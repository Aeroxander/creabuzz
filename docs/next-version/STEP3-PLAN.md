# Step 3, server and app: the build plan (the project page, the holder room, the live feed, streaks, the badge, the ranking, seasons and demo day, alerts away from the app)

Status: a plan, **revised after two independent reviews** (section 12 lists what changed and what was declined). **Nothing in it is built.** It is written for eight engineers who build one after another in two lanes (server P1 to P3, app A1 to A5)
without re-deriving anything. It builds on step 1 and step 2, which are built, checked and pushed at `35ea0a894`
(`docs/next-version/STEP1-REPORT.md`, `STEP2-SERVER-APP-REPORT.md`), and it does not touch `contracts/pot` or any money rule. The owner's
direction is `docs/next-version/JOIN-LEAVE-DESIGN.md` (sections 1, 2.6, 2.7, 2.8 and 8) and is not reopened. The record spec this extends is
`docs/next-version/RECORD-V2.md` (record version 2 stays; every addition is a new field). The first public launch is a test network with play
dollars: every money screen says so. This is not legal or tax advice, and no figure here is a promise of any result for anyone. The legal line,
quoted only as it stands and never reworded:

> "Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever, unless they contribute and earn one."

Legal text, terms, privacy, the age box and "Posts and votes are public" are never hidden or reworded by this work.

How to read it. **checked** = read in the tree on 20 November 2026 (file and line named). **(C#)** = a point that was open and that I chose under
the owner's standing go; section 11 lists each with its alternative; the owner may overrule any. Numbers in the worked examples are
arithmetic for the reader; **no engineer copies one into a record, a fixture, an example or a test**: every number in those is produced by the
real run or computed from the record (V4 of the brief; `scripts/chain-reader-fixture.py` and `record-v2-example.json` are regenerated, never edited).

---

## 0. The shape of it in one page

**What a person gets.**

- **A stranger** opens one link, `/p/<id>-<founder>` (the link that already exists and already unfurls with a title, a line and an image that carry no
  price and no count: `share_preview.rs`), and on one phone screen reads: what the project is, **"the project's money"**, how long money has stayed
  in it, whether it is **Established** (a hint, never a power), the last update and the weeks of updates in a row, whether the door is open, the
  fixed banner "You can take your money out any time. Nothing here promises a profit.", the line "This can go up or down. It is not a return.",
  that the dollars are play money, and a **Back** button. A **Share** button gives the link and a picture with no amount and no gain figure on it.
- **A holder** also gets a **room** (read by anyone, written only by people who back the project, decided by the server from the network and never by
  anyone's word), a **live feed** (joins and take-outs given equal weight, "net money in" beside them, amounts rounded to the nearest 100, no names),
  **their own weeks held**, and **an alert on the phone when the app is closed** (a short message, no amount and no name, when a task is planned,
  taken or ended on a project they back; off unless the operator set it up).
- **A founder** writes the perks in words, removes a post from their room, stops a person writing for up to 30 days, and enters the project in a **season**.
- **The operator** starts a season (a six-week group with open entry; demo day is the day its projects are shown together), removes a post from any
  room, and turns web push on with their own keys.

```
contracts/pot (untouched)                       the truth
        | logs + views at one final block
        v
chain_reader (P1)  ---- chain_balance_changes + chain_blocks ----> held ages (bounded SQL, new indexes)
        |                chain_logs rows (joins, take-outs, tasks, check-ins) ----> feed, streaks
        v
record kind 39009, version 2 + four new keys: held, feed, streaks, established      (P1; additive; signed by the server)
        |  and one small signed index of the ranking (kind 39009, d = explore), built from five columns the reader keeps per project (P1)
        |
        +--> app: the project page (A1), the ranking on Home (A1), the live feed and own streak (A2)
        |
relay rules (P2)   room events (kinds 1, 6, 7, 16, 1111 carrying `t = room:<chain key>`, or answering a room post): who may write, from chain_balances + wallet bindings (kind 37017)
                   seasons: one new kind (37021, signed by an operator) + entry records (kind 47003, a new tag family, signed by the project's team; the operator can remove one)
                   removal by the team, mute by the team, public reads of the room
        |
        +--> app: the holder room (A3), seasons and demo day (A4)
        |
web push (P3)      subscriptions (PUT/DELETE, signed), a durable outbox, a sender with backoff and a terminal state, off unless the operator
                   set keys; the sponsored-fee limit per account per day (missing today)
        |
        +--> app: the opt-in on You and the service worker (A4); the joined-up loops and the report (A5)
```

**The six rules everything below follows.**

1. **The network decides, never a person's word (R1).** Who may write in a room, whether a project is Established, what a ranking says and how long
   money has been held come from the chain's logs as the server's reader stored them, or from the server's signed record. A record or a tag a team
   member or stranger signs can say anything; it changes none of these.
2. **No per-person rows are published (R2).** The record carries aggregates only: counts, sums rounded to 100, shares of the whole. A holder's own
   "weeks held" is worked out on their own device from their own chain history. No name, no address, no per-person amount is in the feed, the
   record, a push or a share card.
3. **A hint is a hint (R3).** The badge, the ranking, the streaks and the feed carry no power and no money rule, there are no points and no airdrop, and
   nothing is ranked by price or by volume. They can be faked at the cost of the 2% fee on a real network and for nothing on play dollars (design
   section 10); the page says "a hint, not a promise".
4. **Everything is bounded and every cut is said (R4).** A query reads at most a stated number of rows; a project that goes over is `null` ("not
   known here"), never a smaller number and never zero. A failed read is never turned into an empty or a zero result (review rule 1).
5. **Prefer a record or a tag on an existing kind, then a new kind, then an HTTP path (R5).** The room is kind 1 and kind 7 with one tag. The new
   record is kind 37021 (a season) and nothing else is new; the two HTTP paths (web push subscriptions, the sponsor) are there for stated reasons
   (C8, C27).
6. **Leaving is never slowed (R6).** Nothing here sits in front of Take out. If the room, the feed, the ranking, the alerts or the whole of the new
   record fail, money screens, Back and Take out work as in step 2.

**Words used.** *Room*: the place under a project where people who back it write. *Held for 30 days*: backer Shares an account has held without its
balance falling below that amount at any moment of the last 30 days (section 2.2). *The unit N*: the project's time unit (7 days on a real network,
a multiple of 168 seconds on a test one); a "day" is `N / 7` seconds and an "hour" `N / 168`, in every window below, so a test network with a short
unit shows the same behaviour in minutes. *The reader*: the server's chain reader (`crates/buzz-relay/src/chain_reader`). *Bound wallet*: an address
that an account proved is its own with a kind 37017 record (verified when it was stored). *The team*: the founder and the people the founder lists as team on the project's own record (`team` tags; `handlers/launch_update_authority.rs` reads them as they stand). **The founder alone controls that list**; there is no separate acceptance step in the code, so a team's power over a room is the founder's power. The app words are the plain ones of section 7; this page
uses the contract and server words so engineers can find them.

---

## 1. What is already built, and what this step reuses

Checked in the tree. "Reuse" means the package calls it and does not rebuild it.

| Need | What exists (file) | What this step does with it |
|---|---|---|
| Every fact for the feed, streaks and holders' counts | `chain_reader::store::project_logs` loads **every decoded non-Transfer row of a project with its block time** on each build (`LogRow { block, log_index, time, tx, role, event, fields }`); `Ledger::from_logs` keeps the totals. `Joined`, `Left`, `TeamLeft`, `CheckedIn`, `RateProposed`, `DoorSet`, `WoundDown`, `TaskAnnounced`, `TaskTaken`, `TaskResolved` are all in it | **P1 reads the same `&[LogRow]`**; no new scan. The feed and the streaks are pure functions of these rows |
| How long money has been held | `chain_balance_changes (reader, block_number, log_index, account, project_key, token, delta)` and `chain_balances` (migrations 0067 to 0070; both operator-global, rolled back with the logs), `chain_blocks (reader, number, block_time)`; `store::balances` gives each account's balance at the final block | **P1 adds one bounded SQL and two indexes** (migration 0073); nothing else is stored |
| Signing and publishing a record | `numbers::build`, `record.rs::validate` (with `deny_unknown_fields`), `publish.rs`, the cross-checks of RECORD-V2 4.3, `facts_of` (what re-signs a record) | **P1 adds four keys**; none can fail a money field (section 2.1) |
| The project page and its parts | `project/ProjectPage.tsx` (header, `JoinBox`, `PlannedStrips`, tabs Updates, Tasks, People, Money), `pot/BackCard.tsx` + `BackSheet.tsx`, `pot/MoneyFacts.tsx`, `pot/pot-words.ts` (`NOT_A_RETURN`, `CAN_TAKE_OUT`, `PLAY_MONEY_WORDS`), `money/numbers*.ts` (strict parser; `freshnessOf`) | **A1 builds the one-screen top block** from these and mounts the room and feed through two stubs |
| Link and preview | `crates/buzz-relay/src/share_preview.rs`: `/p/<id>-<first 16 hex of the founder>` and `/launchpad/<id>` answer `index.html` with a real title, description and the one static image `/assets/share-card.png`, "no price, no returns, no counts"; `app/src/features/project/project-record.ts` (`projectRef`, `parseProjectRef`, `projectPath`) | **The link is unchanged.** A1 adds the Share button and a picture the person's own device draws. The server's unfurl stays as it is (it already carries no amount) |
| Share picture drawing | Only the old `web/src/features/launchpad/lib/share-card.ts` (a canvas drawer written for the old scorecard facts; has `FORBIDDEN_ON_CARD` and a recording-context test) | A1 writes a new small drawer in the app with the same test pattern; **nothing is moved out of `web/`** |
| Posts, replies, likes, threads | kind 1 text notes with NIP-10 `e` tags, kind 7 votes: `features/posts/*` (`PostCard`, `PostPage`, `Composer`, `use-posts.ts`), builders `buildPost`, `buildReply`, `buildVote` in `packages/creaton-core/src/social/feed/feed-events.ts`; posts about a project carry `["a", "37001:<founder>:<id>"]` | **The room is these, with one more tag** (section 4.1): `["t", "room:<chain key>"]`. A3 reuses the cards and the thread page |
| Reporting | kind 1984 (NIP-56): `handlers/report.rs` stores it in the moderation queue, never fans it out; `crates/buzz-admin/src/reports.rs` | Reused as is |
| Removing a post | kind 9005 with no `h` tag and one `e` tag: `handlers/home_moderation.rs` (community owners and admins; a public reason; the soft delete, the audit row and a public log entry kind 45004 in one transaction) | **P2 lets the project's team use the same request for posts in their own room** |
| A person's own mute | `packages/creaton-core/src/social/mute/mute-list.ts` (private NIP-51 kind 10000, encrypted to oneself) | A3 wires it to "Hide this person" |
| Global mutes, bans, write restrictions | `enforce_write_restriction` in `handlers/ingest.rs` | Applies to room writes without change |
| Which wallet is whose | kind 37017, verified when stored (`ingest.rs::validate_evm_binding`: a wallet by signature offline; a smart account by asking the chain, needs `BUZZ_EVM_AUTH` and `BUZZ_EVM_RPC_URL`); app: `team/use-wallets.ts` (`useTeamWallets`, `useLinkWallet`), `team/LinkWallet.tsx` (**hidden for a passkey account today**: `signsMessages` is false) | P2 reads bindings to decide who may write; **A3 makes linking work for a passkey account** with `packages/creaton-core/src/aa/kernel-signature.ts` (`signKernelHash`, built and tested) |
| Reading the chain's holders in a rule | `handlers/task_chain.rs`: `chain_key_of`, `chain_task_of`, the `ProjectLaunched.projectId == hash of the coordinate` tie, `AS_OF_SQL` (the reader's newest block time) | **P2 follows this file's pattern** for the room and for season entries |
| Who signs 47003 records | `handlers/launch_update_authority.rs` (a table of families and signers, checked once at write), `OPEN_WORK_KEYS` | P2 adds three families |
| Reading without an account | `api/public_read.rs` (`BUZZ_PUBLIC_PROJECT_READS`: kinds 37001 and 47003 only, one project per filter, bounded, cached) | **P2 adds the room and the season records to it**, still one project per filter |
| In-app alerts | `app/src/features/alerts/*`: ids `${chainKey}:${serial}:${kind}`, kinds `planned`, `taken`, `ran-out`, `ended`, `claim`, derived from the signed record | Push uses the **same three kinds** (planned, taken, ended); `ran-out` is sent as ended; `claim` stays in the app |
| Push in the relay | `push_runtime.rs`, `handlers/push_lease.rs`, `push_leases`, `push_wake_outbox`: **NIP-PL**, a lease encrypted for an iOS gateway (`buzz-push-gateway`, App Attest, APNs); `PUSH_KINDS = [9, 40002, 45001, 45003]` | **Not reusable for a browser** (no endpoint grant, no App Attest, no web transport, matches events by filter and not chain tasks). P3 copies its *patterns* (claim with a lease, attempts, next attempt, terminal `failed`) |
| Web push | **Nothing.** No `push`, `notificationclick`, VAPID or web-push code anywhere (`app/public/sw.js` caches the shell only; checked by search). The app **is installable** (`app/public/assets/manifest.webmanifest`, `display: standalone`) and registers `/sw.js` in production builds only (`app/src/main.tsx:61`); on an iPhone web push works only for an app added to the Home Screen | P3 builds the sender; A4 the service worker handlers and the opt-in |
| Crates for the sender | `hmac 0.13`, `jsonwebtoken 10.4.0`, `reqwest 0.13` and `sha2 0.11` are workspace dependencies of `buzz-relay`. `p256 0.13.2`, `hkdf 0.13.0` and `aes-gcm 0.10.3` are only **transitive** in `Cargo.lock` (`aes-gcm` is a direct dependency of `buzz-push-gateway` alone); **no web-push crate** | P3 adds `p256`, `hkdf` and `aes-gcm` as direct dependencies (root `Cargo.toml` and `crates/buzz-relay/Cargo.toml`), writes RFC 8291 (message encryption) and RFC 8292 (VAPID) on them, proven against the RFC's own test vector (section 6.4) |
| Background jobs | `chain_reader::spawn` and `push_runtime` start from `main.rs`; the helper job keeps a writer lock and uses retry records (`chain_helper_jobs`) | P3 starts its own supervised task from `main.rs` with an advisory lock of its own |
| A sponsor for the phone's fee | **None in the repo.** `zd_sponsorUserOperation` appears only in the client (`packages/creaton-core/src/aa/*`) and its tests; `PHONE-PATH-REPORT.md` says the per-account daily limit "must be enforced at the sponsor, or a thin service the operator runs in front of it" | **The limit is missing. P3 builds that thin service** (section 6.7) |
| Seasons | **Nothing.** No `season` anywhere in `crates`, `app`, `packages` (checked). `docs/PLAN-V2.md` section 5 and milestone 10 describe it with rounds | P2 and A4 build it for the new money model (section 5) |
| Channels with the `h` tag, boards, board mutes | The relay has NIP-29 channels, forum posts (45001, 45003) and board moderation (9045 to 9053, `board_moderation.rs`); **the Creaton app uses none of them** (checked: no `h` tag in `app/src`) | **Not used** (C1): membership there is a list someone edits; a room whose writers are decided by the chain would need a job that adds and removes members after every transfer, and a lag in it is a person shut out |
| The sign-in legal line | `app/src/features/account/PolicyBoxes.tsx` ("I agree … Posts and votes are public.") | A3 shows "Posts and votes are public." beside every place a person writes in a room |
| Press and size gates | `app/scripts/check-file-sizes.mjs` (app source files at most 600 lines, tests 1000), `check:copy`, `check:px-text`, biome, knip | Every package keeps to them |

---

## 2. Record additions (P1: `crates/buzz-relay/src/chain_reader`)

Additive inside version 2: no field is removed, renamed or re-meant, so the version stays 2 (RECORD-V2 section 1: "Adding a field never changes the
version"). Four new keys at the top level of the record: **`held`**, **`feed`**, **`streaks`**, **`established`**. They are always present as keys; a
value the server could not work out is `null` (never `0`, never `[]`), and `null` means "not known here". The Rust `Record` struct gains the four
fields (`deny_unknown_fields` stays); the app parser reads them apart from the money (section 2.7).

### 2.1 What can fail, and what does not

A failure in the new work must not freeze a project's money. So, unlike the task section of step 2 (where a failed check fails the whole build because
dropping the section would hide a planned task from holders), **here a failure of a new key makes that key `null`, logs one error line that names the
project, the key and the reason, counts it (`social_failed`), and the rest of the record is signed as usual**. What is never allowed: a number that
is wrong. The key is either right (its own checks passed) or `null`. The checks are in 2.6.

### 2.2 `held`: how long money has stayed (the ranking's inputs and the badge's first input)

| Field | Type | Meaning | From |
|---|---|---|---|
| `held.windows.rankSecs` | int | The ranking window: 30 days, `30 × (unit / 7)` seconds | `limits`-style constant `RANK_DAYS = 30` times the record's `unit` |
| `held.windows.badgeSecs` | int | The badge window: 13 units, `13 × unit` seconds (91 days on a real network) | constant `BADGE_UNITS = 13` (the design's 13N; the same 13 as the dormant clock, RECORD-V2 S5) |
| `held.rank` | object or null | `{shares, bps, money, accounts}` below, for `rankSecs`; **null when this window could not be counted** (the badge window and the rank window are counted apart: one can be null while the other stands) | section 2.2.1 |
| `held.rank.shares` | amount (18 dec) | Backer Shares that were held **without a fall** for `rankSecs` up to `asOf.time`: the sum over accounts of the **lowest balance the account had at any moment of the window** | `chain_balance_changes` + `chain_balances`, section 2.2.1 |
| `held.rank.bps` | int | `floor(10000 × rank.shares / shares.backers)`; 0 with no backers | arithmetic |
| `held.rank.money` | amount (6 dec) | What those Shares would get if taken out at the record's own per-Share figure: `mulDiv(rank.shares, value.leaveValue, 1e18)`. For lists and words, never for a sheet; carries the 6-decimal rounding of `value.leaveValue` (a relative error of at most about one part in a hundred at a one-cent Share; RECORD-V2 2.5) | arithmetic on two fields of the record |
| `held.rank.accounts` | int | How many accounts hold, at that lowest balance, at least the smallest Back (`limits.minJoin`) at the record's per-Share figure | same query |
| `held.badge` | object or null | `{shares, bps}` as above for `badgeSecs` (no `money` or `accounts` of its own: nothing reads them); null when this window could not be counted | same query |
| `held.countedAccounts` | int | Accounts that hold **now** at least the smallest Back at the record's per-Share figure (the badge's second input; the full count, never cut at 200 like `holders`) | `chain_balances` at the final block |

The excluded accounts are **exactly** the ones `Ledger::holders(launcher)` leaves out (`ledger.rs`: the zero address, the Treasury, the Vester, the
Shares and Team tokens and the dollar, plus the Launcher, which `numbers.rs` passes as the extra account; RECORD-V2 2.11): Shares sent there are stuck
and nobody holds them. P1 does not write the list a second time: it adds one function, `Ledger::excluded(launcher)`, that `holders` and `held` both call
(P1 owns `ledger.rs` for that one function), and `held_at_zero_window_is_the_supply` and the `holderCount` cross-checks compare the two.

**2.2.1 How it is worked out: inside Postgres, one row per account, no per-person row published.** The lowest balance of each account is worked out
by the database with a running sum, so the change rows are never shipped to the server's memory and the work is the rows of **this project inside the
window**, read through an index range, never a sort of a bigger set. Two queries per project per build, one per window (`$4` is the window's start,
`asOf.time - window`):

```sql
-- $1 reader, $2 project key, $3 final block, $4 window start (a block time), $5 rows cap, $6 accounts cap
WITH first AS (                         -- the first block inside the window, from idx_chain_blocks_time
  SELECT min(number) AS n FROM chain_blocks WHERE reader = $1 AND block_time > $4),
win AS (                                -- this project's change rows inside the window, at most $5 + 1 read
  SELECT c.account, c.block_number, c.log_index, c.delta
  FROM chain_balance_changes c, first
  WHERE c.reader = $1 AND c.project_key = $2 AND c.token = 'shares'
    AND c.block_number >= first.n AND c.block_number <= $3
  ORDER BY c.block_number, c.log_index
  LIMIT $5 + 1)
SELECT account, sum(delta)::text AS total, min(cum)::text AS lowest_run, max(rows_read) AS rows_read
FROM (SELECT account, delta,
             sum(delta) OVER (PARTITION BY account ORDER BY block_number, log_index) AS cum,
             count(*) OVER () AS rows_read FROM win) r
GROUP BY account LIMIT $6 + 1
```

(Written for the engineer to refine. What must hold: the lower bound is the first block of the window found through `idx_chain_blocks_time`, the rows
come in block order from `idx_chain_balance_changes_block` (migration 0073: `(reader, project_key, token, block_number)`), and the `LIMIT` sits **inside**
`win`, before the running sum, so a project with a million changes is read for at most `$5 + 1` of them.) In Rust, for each account that moved in the
window: its balance at the window's start is its balance now (`store::balances` at the final block) minus `total`, and its lowest balance reached is
`balance_now - total + min(0, lowest_run)`: the start balance counts, and so does every change inside one block, because the running sum steps through
`(block, log_index)`, so an intermediate state counts. An account with no change in the window held its balance now for the whole window.
`held.*.shares` is the sum over accounts; `accounts` counts those at or above the smallest Back at the record's per-Share figure.

**Why a minimum and not an age.** Held-for-a-window is "the most the account can be said to have held the whole time". It cannot be topped up by
moving Shares around: a Share bought yesterday does not count for 30 days; a Share moved to a second account of the same person starts that account's
clock at zero and lowers the first account's minimum by the same amount, so the total can only fall. Selling and buying back lowers it. Nothing here
needs a name or an address in the record, and a person's own figure is not in it (A2 works it out from their own chain reads, section 2.5).

**The bound (R4), and what it costs.** `HELD_ROWS_MAX = 500,000` change rows per window query (the `LIMIT` inside `win`) and `HELD_ACCOUNTS_MAX = 20,000`
accounts. Over either, **that window's key** (`held.rank` or `held.badge`) is `null` with one logged line and a count (`held_cut`): the app then shows no
ranking row or no badge for it, never a smaller number. The two windows are counted apart, so a project that is over the cap in 91 days can still have
its 30-day figure. **Said plainly:** a person who holds a few Shares of a project can make about 250,000 one-wei moves in 91 days (each move is two
rows) and push that project's `held.badge` to null, and a very busy project can pass the cap on its own (about 2,700 moves a day for 91 days). What is
lost is a ranking row or a badge, both display only; the money, Back and Take out are untouched. On a real network the first costs real fees; on play
dollars it costs nothing. No remedy is built in this step: it is recorded (section 9.1 #2) and `held_cut` is in the pass report so an operator sees it.

**Worked example (arithmetic, an illustration; tests compute from the fixture).** Three accounts hold 40, 40 and 20 Shares. The first has held 40
for 100 days, the second bought its 40 six days ago, the third had 30, sold 10 twelve days ago and holds 20. Over a window of 30 days the lowest
balances are 40, 0 and 20: `rank.shares` is 60 of 100, `rank.bps` 6000, `rank.accounts` 2 (the second counts for nothing yet).

### 2.3 `established`: the badge's three inputs and the server's verdict (design 2.6)

| Field | Type | Meaning | From |
|---|---|---|---|
| `established.rule.minHeldBps` | int | 6000: at least 60% of the money held for the badge window | server constant `ESTABLISHED_MIN_HELD_BPS` (the design's 60%) |
| `established.rule.heldSecs` | int | equals `held.windows.badgeSecs` | same |
| `established.rule.minAccounts` | int | 10 | server constant `ESTABLISHED_MIN_ACCOUNTS` |
| `established.heldBps` | int or null | `held.badge.bps`; null when `held.badge` is null | `held` |
| `established.accounts` | int or null | `held.countedAccounts`; null when `held` is absent | `held` |
| `established.twoSigners` | bool | `runner.isPair` and `runner.signers` are two different non-zero addresses | `runner` |
| `established.reached` | bool or null | `heldBps >= minHeldBps && accounts >= minAccounts && twoSigners`; null when `held.badge` is null | arithmetic |

The three thresholds are the design's (60%, 13N, 10 accounts, two signers). They are server constants because the contracts have no number for them
(the same reason as S5 for "dormant"); they ship **in the record** so the app and the tests read them and do not copy them. It is display only (C15
of the design): no screen unlocks a power from it.

**Worked example of design 2.6 (arithmetic).** 100,000 joined, of which 62,000 has sat 91 days or more: `heldBps` is 6200; 12 accounts hold; two
signers: **reached**. At 58,000: `heldBps` 5800: **not reached**; no rule changes either way. At 9 accounts: not reached. The app's tests build these three
cases from the fixture's chain run by moving the chain's clock (section 9.2, H5), not from typed numbers.

### 2.4 `feed`: joins and take-outs, rounded, with no names

| Field | Type | Meaning | From |
|---|---|---|---|
| `feed.roundTo` | amount (6 dec) | The rounding step: 100 dollars (`100 × 10^6`). In the record so the app and the tests read it | constant `FEED_ROUND_DOLLARS = 100` |
| `feed.bucketSecs` | int | The length of one hour bucket: `unit / 168` | `unit` |
| `feed.hours` | array | The last **48** hour buckets ending at the one that holds `asOf.time`, oldest first, **every bucket present (a quiet hour is a zero bucket)** | `LogRow`s of `Joined`, `Left`, `TeamLeft` |
| `feed.hours[].at` | int | The bucket's first second: `asOf.time - asOf.time % bucketSecs - k × bucketSecs` | arithmetic |
| `feed.hours[].joins` | int | How many `Joined` events fell in it | rows |
| `feed.hours[].tookOut` | int | How many `Left` and `TeamLeft` events fell in it (a take-out by a Team Share holder counts: equal weight) | rows |
| `feed.hours[].net` | object | `{dir, amount}`: `dir` is `"in"`, `"out"` or `"even"`; `amount` is the **absolute** net money in rounded half up to `roundTo` (`"0"` when `dir` is `"even"`). Net money in the bucket is `Σ (Joined.paid - Joined.fee) - Σ (Left.cash + TeamLeft.cash)` | rows |
| `feed.items` | array | Up to **30** things that are not money flows, newest first, within the last 28 days (`28 × unit / 7` seconds) | rows |
| `feed.items[].kind` | enum | `task_planned`, `task_taken`, `task_paid`, `task_ended` (sent back, lapsed or ran out), `task_withdrawn`, `update` (a `CheckedIn`). (Rate raises and wind-downs are not items: the money screens already say them.) | rows |
| `feed.items[].at` | int | When it happened (the block's time) | rows |
| `feed.items[].serial` | int or null | The task's number for the `task_*` kinds, otherwise null | rows |
| `feed.items[].date` | int or null | For `task_planned`: when it can first be taken (`noticeEnd`); for `task_taken`: the deadline; otherwise null | the task rows |
| `feed.cut` | int | How many items were left out because of the 30 | arithmetic |

**Rounding.** `round(x) = ((x + roundTo / 2) / roundTo) × roundTo` in integers, rounded half up, **applied to the bucket's net and never to a
single event**. Nothing finer than 100 dollars is ever published, and a bucket with one 40-dollar join and nothing else reads `joins: 1`, net
`"even"`. "Net money in" is the only amount in the feed: **volume (money in plus money out) is not published**: no bucket carries the two sides apart,
so for a bucket that has both joins and take-outs it cannot be worked out. (A bucket with joins and no take-outs has a net equal to its volume, to the
nearest 100 dollars: a one-join hour shows that person's amount to within 50 dollars. That is allowed and said: the chain is public and shows it
already; the feed adds nothing a reader of the chain cannot see.) Joins and take-outs are two counts of the same kind, in the same place, so the app can show them at equal weight.

Why hour buckets and not one row per event: a row with a time to the second and an amount ties a take-out to one transaction on the public chain,
and a small project's feed would then be a list of its people's moves. Buckets keep the feed useful ("3 backed and 1 took out in the last hour")
and keep a name out of reach (R2). The chain itself is public; the feed adds nothing a reader of the chain cannot see, and takes nothing out.

**What is not in the feed.** Names, addresses, per-event amounts, a task's dollar amount (the plan's own strip shows "up to X"), grants, agents,
anything about Team Shares beyond the take-out count.

### 2.5 `streaks`: whose weeks

| Field | Type | Meaning | From |
|---|---|---|---|
| `streaks.updates.weeks` | int | The project's weeks of updates in a row. Windows are one unit long and **aligned to the launch**: window `k` is `[launchedAt + k × unit, launchedAt + (k+1) × unit)`. Counted back from the window that holds `asOf.time`: the number of consecutive windows, newest first, that each hold at least one `CheckedIn`. The window that holds `asOf.time` is still open: empty, it is skipped; with a check-in, it counts. The first empty **closed** window ends the run. A fixed grid gives the same answer on every pass (a window anchored at `asOf` slid and flapped). **It is stricter than the contract's own rule on purpose**: the contract keeps a project live with one check-in in 2 units, but the page says "weeks of updates in a row" and means a week with an update, so a project that checks in every 10 days shows fewer weeks and is not marked down otherwise | `CheckedIn` rows, `launchedAt` |
| `streaks.updates.longest` | int | The longest such run in the project's life | rows |
| `streaks.updates.lastAt` | int or null | The newest check-in | rows |

**Weeks held is the person's own, and is not in the record.** "You have held it for N weeks" is the number of whole units since the account's
balance of that project's Shares last became positive and stayed so (a take-out to zero or a transfer to zero resets it). It is worked out on the
person's own device from **their own** chain history (two `getLogs` calls on the Shares token with the person's address as the `from` topic and as the
`to` topic, which `pot/own-history.ts` already does for their take-outs), through the reader the app already has. No server work, nothing published,
so no per-person row exists (R2). A person with several accounts (a wallet and a passkey account) sees the figure of the account they are using. It has
no reward: no points, no badge, nothing unlocks (R3).

### 2.6 What the server checks before it signs these keys

Every check runs on every build; a failure makes **that key** `null` (2.1). Each has a test that fails with the check removed (section 9.2).

- `held`: `badge.shares <= rank.shares <= shares.backers` (each when present); `rank.accounts <= countedAccounts <= holderCount`; at a window of zero the
  worked minimums equal the account balances (the unit test `held_at_zero_window_is_the_supply`: the sum of all non-excluded balances equals
  `shares.backers` less the Shares held by the excluded accounts); `bps` equals the arithmetic; the walk uses only rows at or below the final block
  and their block times are at or below `asOf.time`.
- `feed`: exactly 48 buckets, ascending, each `at` a multiple of `bucketSecs`, the last holds `asOf.time`; every `net.amount` is a multiple of
  `roundTo`; `dir` is `"even"` exactly when the amount is `"0"`; items newest first, at most 30, every kind in the list, `serial` present exactly for
  `task_*`; the sum of `joins` over all hours **in the window** equals the count of `Joined` rows in the window (recomputed from the rows by a second,
  independent function in `validate`).
- `streaks`: `weeks <= longest`; `lastAt` equals the newest `clock.lastCheckIn`-era check-in (it is at most `clock.lastCheckIn`).
- `established`: `reached` equals the rule on its own inputs; the rule fields equal the server's constants; `heldSecs == held.windows.badgeSecs`.
- All four keys are present as keys in every record; a removed project's record stays the removal form.

`facts_of` (what makes the server sign again) strips the four keys entirely: each moves with time (a window slides), and each event that changes one
(a join, a take-out, a task, a check-in, a rate raise, a door change) already changes a field that is in the digest. So the four keys do not make a
record sign every pass; they are refreshed at the record's own refresh time (600 s while money moves, 3,600 s otherwise; step 2 rule, unchanged).

### 2.7 What the app shows when a field is absent, wrong or old

The new keys are parsed **apart from the money**: `readSocial(body)` returns four nullable parts and **never** makes the whole record unreadable (the step
1 and 2 parser is strict on money fields and stays so). A hostile or malformed `held`, `feed`, `streaks` or `established` reads as `null` for that part
only.

| State | `held` | `feed` | `streaks` | `established` |
|---|---|---|---|---|
| Key missing (an older server) | no ranking row, no "kept" line | the feed section is not drawn | no streak line | no chip; Details says "This server has not told us yet." |
| `null` (too many moves, or a failed check) | as missing, never "none" or "0" | as missing | as missing | no chip |
| Record older than 3 refresh periods | the figures carry the record's existing "as of" | rows carry "(as of 14:05)" | same | same |
| Record older than 24 hours | **hidden** with the other money figures (RECORD-V2 section 6) | hidden | the streak may stay (it is not money) with "as of" | hidden |
| Project removed (`removed: true`) | nothing | nothing | nothing | nothing |
| Parts the app does not know (a newer server) | ignored | unknown item kinds are skipped, never shown as something else | ignored | ignored |

The ranking reads the index of 2.8 and never `held` itself; the page's "kept" line (7.1 row 8) reads `held.rank`. A project with no record at all is not ranked and shows no chip (a ranking of what is read never claims to be complete: it says "of the projects this
server has numbers for").

### 2.8 The ranking: one small signed index, and its rule

Home does **not** work the ranking out from the project records it reads for browsing. That read (`use-home.ts`) is the newest 60 kind 37001 records, so
it is ordered by when a founder last edited a record: an old project whose money has stayed longest falls out once 60 newer records exist, a founder can
edit to stay in, sixty junk records push everyone else out, and sixty records is heavy for a phone's Home. **The server signs one small index and Home
reads that one record**, then only the records of the few projects it lists.

- **The record.** Kind 39009 (the kind the reader already signs), `d = "explore"`, the same tags (`d`, `chain`, `launcher`), signed by the relay's key. Content:
  `{"version": 1, "kind": "explore", "asOf": {"block", "time"}, "entries": [...], "seen": <n>, "cut": <n>}`. An entry is `{"key", "a": "37001:<founder>:<id>",
  "launchedAt", "windowSecs", "money" (6 decimals), "accounts", "reached"}`: `money` is the project's `held.rank.money`, `accounts` its `held.rank.accounts`,
  `reached` its `established.reached`. At most **20** entries (about 4 KB), sorted by the rule below; `seen` counts the projects that have a ranking
  row and `cut` those left out of the 20. No name, no address, no per-person figure.
- **Where the rows come from.** Migration 0073 adds five nullable columns to `chain_project_numbers` (an operator-global table already classified, so no
  registry or trigger line changes): `rank_money NUMERIC(78,0)`, `rank_accounts INTEGER`, `rank_window_secs BIGINT`, `reached BOOLEAN`, `launched_at
  BIGINT`, null when `held.rank` is null. The statement that records a signed project record writes them in the same transaction, so they cannot
  disagree with the record; a project whose launch is rolled back loses its row as it does today.
- **The coordinate, and who may be listed.** The reader holds a project's key, not its founder and id. When it builds the index it reads the newest 5,000
  listed kind 37001 events of the community (one query; `cut` counts more), takes each one's `chain-key` tag, and lists the project **only if
  `ProjectLaunched.projectId` equals the hash of that record's coordinate** (the tie `task_chain::chain_task_of` already checks). A founder cannot claim
  another project's key, and no one's word decides who is eligible.
- **When.** At the end of every `publish_pass`, at most once per 600 s and only when the entries differ from the live index's. A failure to build it is
  logged and counted (`explore_failed`), the old index stays, and nothing else is affected (R6). Pure: `explore_of(rows) -> Index`.
- **The rule.** Sorted by `money` (largest first), then `accounts`, then `launchedAt` (older first), then `key`. A project with `held.rank` null or
  with `money` zero is not listed. Never the pot, never the price of a Share, never joins, never volume, never anything in the feed. **It is money held,
  valued at what a take-out would give now** (`value.leaveValue`): adding money to a project raises it for everyone who holds, at the cost of whoever added
  it; it is not the price of a Share and the index carries no price field. Each row shows the money and the number of different accounts beside it ("a
  hint": accounts are free on a test network).
- **The app** (A1) reads the index with one filter (`kinds [39009]`, `#d [explore]`), checks that the relay's key signed it, hides it when it is older than
  24 hours (as every money figure), **sorts by the same rule itself and never trusts the order**, reads the records of the first ten entries by
  coordinate (`readMulti`), drops an entry whose record is missing, unlisted or removed, and shows at most 8. It is read through the same path as every
  numbers record (it is not on the public-read list, so a signed-out visitor on an invite-only server sees no ranking, as no numbers).
- **Bytes, said now:** one index of about 4 KB plus at most ten project records Home mostly reads already; A5 measures the bytes Home reads and the
  report says them.

---

## 3. Server work, P1: the record's additions (`crates/buzz-relay/src/chain_reader`, the fixture, the example, the spec)

### 3.1 Files

| File | Change |
|---|---|
| `chain_reader/held.rs` (new) | The held-for-a-window work. `pub async fn held_input(pool, reader, key, final_block, as_of_time, window_secs, rows_max, accounts_max) -> anyhow::Result<WindowRaw>` runs the one query of 2.2.1 for one window (`WindowRaw` is `Counted(per-account totals and lowest runs)` or `Cut`; a database error is an `Err`, never `Cut`) and `pub fn lowest(raw, balances_now) -> Held` is **pure** (no database) and holds the minimum-over-a-window rule; unit-tested without Postgres. No SQL anywhere else for this (`store.rs` is not touched). |
| `chain_reader/record_social.rs` (new) | The four record types (`HeldRec`, `FeedRec`, `StreaksRec`, `EstablishedRec`) with `serde` names as in section 2, the constants (`RANK_DAYS`, `BADGE_UNITS`, `ESTABLISHED_MIN_HELD_BPS`, `ESTABLISHED_MIN_ACCOUNTS`, `FEED_HOURS`, `FEED_ITEMS`, `FEED_WINDOW_DAYS`, `FEED_ROUND_DOLLARS`, `HELD_ROWS_MAX`, `HELD_ACCOUNTS_MAX`), the builders `held_of`, `feed_of(rows, as_of, unit)`, `streaks_of(rows, as_of, unit, launched_at)`, `established_of`, and `social_checks` (2.6). Pure; every function takes rows and returns values. |
| `chain_reader/explore.rs` (new), `explore_tests.rs` (new), `explore_postgres_tests.rs` (new) | The index of 2.8: `explore_of` (pure: rows to the sorted, capped entries), the SQL that reads the ranking columns and the newest 5,000 listed project records and checks the tie, and `publish_explore` (signs through `publish::publish` with `d = explore`). The Postgres tests read only `NOT stale` rows, drop an entry whose tie fails and keep the old index when a build fails. |
| `chain_reader/ledger.rs` | One function, `Ledger::excluded(launcher)`, called by `holders` and by `held` (section 2.2). Nothing else changes. |
| `chain_reader/record_social_tests.rs` (new) | The unit tests of section 9.2 (H, F, S, E series). |
| `chain_reader/held_postgres_tests.rs` (new) | The Postgres tests (`#[ignore]`, run with `--include-ignored --test-threads=1`; the file name ends in `_postgres_tests.rs` so `scripts/check-postgres-test-discovery.py` finds them): the query against rows made with `store::commit_range`, a rollback past a change, and the bound. |
| `chain_reader/record.rs` | `Record` gains `held: Option<HeldRec>`, `feed: Option<FeedRec>`, `streaks: Option<StreaksRec>`, `established: Option<EstablishedRec>`, serialised as `null` when none (no `skip_serializing_if`: the key is always there, as `tasks` is); `deny_unknown_fields` stays; `validate` calls `social_checks` for the keys that are present. |
| `chain_reader/numbers.rs` | `build(...)` takes a `SocialInput { rows: &[LogRow], rank: Option<Held>, badge: Option<Held> }`; a failing `social_checks` for one key sets that key to `None`, logs `chain reader: {project}: {key} not published: {reason}` at error level and counts it; `derive(...)` passes it through; `facts_of` strips the four keys (2.6). Nothing else in `build` changes: **no cross-check of step 1 or step 2 depends on the new keys.** |
| `chain_reader/mod.rs` | `publish_project` calls `held::held_input(...)` twice (rank window, badge window) after `ledger.set_balances(...)` and passes the results and `&logs` to `derive`; **`publish_pass` calls `publish_explore` at its end** (2.8). A database error in `held_input` is logged and becomes `held: None` for that build (it is retried on the next pass; it never fails the build); a cut makes only that window's key null. New lines in the pass report: `social_failed`, `held_cut`, `explore_failed`. |
| `migrations/0073_chain_held_indexes.sql` (the next free number at merge; `ls migrations`) | `CREATE INDEX idx_chain_balance_changes_block ON chain_balance_changes (reader, project_key, token, block_number);`, `CREATE INDEX idx_chain_blocks_time ON chain_blocks (reader, block_time);` and the five nullable ranking columns of 2.8 on `chain_project_numbers`. Additive. |
| `schema/tables/public/chain_balance_changes.sql`, `chain_blocks.sql`, `chain_project_numbers.sql` | The two indexes and the five columns (AGENTS.md gotcha 7: the table file is where `CREATE INDEX` lives; there is no seed DML and no new table, so `schema/seeds`, `crates/buzz-db/src/runtime/migration.rs` and `scripts/reconcile-schema-after-pgschema.sql` need nothing; a test applies the expanded schema to an empty database and asserts both indexes and all five columns exist). |
| `scripts/chain-reader-fixture.py` | The fixture run gains what the new tests need and the run does not have: **one Share transfer from one holder to another** early enough to be older than 30 days at the example block and **one made inside the last 30 days** (so the first account's lowest balance falls and the second's starts late), **a take-out that empties an account**, and a second block of days past 91 so both windows have a non-trivial answer. Deterministic as before (`--check` twice gives the same bytes). |
| `scripts/chain-reader-example-check.py` | **An independent recomputation in Python** of `held`, the feed's hour buckets and items, and the streak from the run's raw logs (`testdata/pot-run.json`), compared with the example, field by field. It shares no code with the Rust (a second implementation is the check). The index of 2.8 is checked in Rust (`explore_postgres_tests.rs`) because it reads the table, not the logs. |
| `crates/buzz-relay/src/chain_reader/testdata/pot-run.json`, `docs/next-version/record-v2-example.json` | **Regenerated** (`python3 -I scripts/chain-reader-fixture.py`, then `UPDATE_EXAMPLE=1 cargo test -p buzz-relay --lib the_example_is_what_the_server_writes`). Never edited by hand. |
| `docs/next-version/RECORD-V2.md` | A new section 11 "Step 3 additions" with the tables of section 2 here (tables only; the reasons stay in this plan), rule 12 in section 7.3 (what both tracks test against the example), a line in section 9 for the choices (C11 to C17 below). |
| `docs/next-version/READER-V2-REPORT.md` | A "Step 3" section (what ran and the exact counts). |

### 3.2 Order inside P1 (and what the app lane waits for)

- **M1 (3 days).** The record types, the builders for `feed`, `streaks` and `established`, `held` from the pure walk with rows given by the test, the
  regenerated fixture and **the first generated example with all four keys**. A1 and A2 build against it. Until it lands they build against a
  fixture labelled `shape-only` and replace it at M1.
- **M2 (days 3 to 10 in 8.2).** The Postgres queries, the indexes and the falsifiable bound test (H9), the nulling, `social_checks`, the Python
  check, **the index record of 2.8** (A1's ranking waits for it and builds against a labelled `shape-only` index until then), the spec text.
- The record must keep passing every step 2 test untouched. If an existing test needs a change because the example's bytes changed, it is
  regenerated, not edited.

### 3.3 Checks P1 runs before handing over

`node scripts/chain-reader-events.mjs --check` (unchanged: no new event); `python3 -I scripts/chain-reader-fixture.py --check` twice (same bytes);
`python3 -I scripts/chain-reader-example-check.py`; `CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 cargo test -p buzz-relay --lib chain_reader`; the same with
`-- --include-ignored --test-threads=1 held_postgres_tests explore_postgres_tests scan_postgres_tests` against the local Postgres and Redis;
`cargo clippy -p buzz-relay --all-targets -- -D warnings`; `cargo fmt -p buzz-relay -- --check`; a pgschema apply of `schema/` and the index check;
`scripts/chain-loop-pot.sh` (the server's loop, which compares the record with the contracts at nine stops: the new keys are compared with the
Python recomputation in `scripts/chain-loop-pot-check.py`, which P1 extends for them). **And exercises** the example's block against `cast`: the
held figure by hand from `cast logs` for one account.

---

## 4. The holder room (P2 decides, A3 draws)

### 4.1 The records and the tags (R5: no new kind)

A room post is **kind 1** and a room like is **kind 7**: the same events the app already writes and reads, with one more tag.

| Event | Tags (besides the ones the builder already writes) | Notes |
|---|---|---|
| Post | `["a", "37001:<founder>:<id>"]` (the project's coordinate, as every post about a project has it); **`["t", "room:<chain key>"]`** where the chain key is the project record's `chain-key` tag, `0x` and 64 lower-case hex digits | One `a` and one `room:` tag, no other `t` starting `room:`. Topic tags typed as `#word` stay allowed (they cannot contain `:`, so they never look like the room tag) |
| Reply | the NIP-10 `e` tags (`root`, `reply`), the same `a` and the same `room:` tag | The root must be a room post of the same room (the rule reads it) |
| Like (kind 7), repost (kind 6 or 16), comment (kind 1111) | `e`, `p`, `k` as the builder writes, plus the same `a` and `room:` tag | The app draws no repost in a room; the rule refuses one that is untagged like any other |

**An event that answers a room post is a room event, whatever tags it carries (review fix).** The app reads replies, likes and reposts by `#e`
(`use-posts.ts`: kinds reaction, repost, text note), so an untagged reply or like from a stranger would show inside a room's thread, and the team could not
remove it (their removal needs the room tag). So `ingest.rs` treats a kind 1, 6, 7, 16 or 1111 event whose `e` tags name a **stored room post** (a stored
event with a `room:` tag) as a room event: it must carry that post's own `a` and `room:` tags or it is refused ("invalid: a reply belongs in the same room
as the post it answers"), and then the rule of 4.2 runs on it. The lookup is one indexed read of the named event (a like already does it:
`derive_reaction_channel`, `ingest.rs`). Reports (kind 1984) and an author's own deletions (kind 5) are not in the list: anyone may report a post. The room
is read, thread replies included, **by its tag only** (A3), so nothing untagged can enter a room's view.

**Why `t`.** The relay filters only on single-letter tags, and the room must be readable with one filter: `{"kinds":[1,7], "#a":[coordinate],
"#t":["room:<key>"]}`. `t` is the topic tag the feed already indexes. A post cannot hold the room tag by accident: the app's topic extractor takes
`#word` of 2 to 32 letters, digits, `_` and `-`, so it can never produce a `:`.

**Not channels (C1).** The relay has NIP-29 channels, forum posts and board mutes, and the Creaton app uses none. They keep a member list that
somebody edits; a room whose writers are whoever holds Shares now would need a job that adds and removes members after every transfer, and any lag in
that job is a holder shut out or a leaver let in. A rule on write that reads the stored chain rows has no list to keep.

**Other clients (said).** A room post is a kind 1 text note, so the desktop and web apps may show it in their own timelines; the room's words are public
(the legal text says so) and the removal and mute powers below apply wherever it is shown.

**Text first (C25).** The rule refuses `imeta`, `x`, `image`, `url` and any media tag, and a body over 2,000 characters (the builder's own limit,
`MAX_POST_CHARS`). Plain text with a link in it is allowed and is only text on the screen. No pictures, no files, no previews in this step.

### 4.2 Who may write: decided by the server from the network (`handlers/room_write.rs`, new, P2)

Called from `ingest.rs` for a room event: **a `t` tag that starts with `room:`, or a kind 1, 6, 7, 16 or 1111 event whose `e` tags name a stored room post
(4.1)**. Any other event is not one and nothing here runs for it (so no ordinary post is slowed). Steps, in this order; the first that fails refuses with its sentence (4.2.1):

1. **Shape.** Exactly one `a` tag naming a kind 37001 coordinate, exactly one `room:` tag, no media tag, a reply's root is a room post of this room, the
   text is within bounds.
2. **The project.** The project record (kind 37001) the coordinate names, as it stands: found, listed, not removed, founder not banned or muted (the
   standing `share_preview::public_standing` already decides); its `chain-key` (`task_chain::chain_key_of`) equals the `room:` tag's key; the reader
   has read the launch and `ProjectLaunched.projectId` equals the hash of the coordinate (`task_chain::chain_task_of`'s tie). **A server with no chain
   reader answers "rooms are not switched on".**
3. **Which wallets are the signer's.** The signer's kind 37017 records (at most 20 read), newest per `d` address, not revoked, attestation not expired at
   the **server's clock** (the record is checked once when stored; expiry is checked now), and bound on **the reader's chain** (the `chain` tag, or the
   attestation's domain when the tag is absent: the tag is optional at write, `ingest.rs:2194-2330`, so P2 reads the domain). At most **8** wallets are
   used. No wallet: refuse with the link sentence. (The app prompts a renewal 30 days before an attestation ends, which is 365 days after it was made.)
4. **Does one of them hold, above a floor.** In one SQL on `chain_balances` for this reader and project: any of those wallets with `balance >=
   ROOM_MIN_SHARES` (10^15 wei, 0.001 of a Share; the same floor for the Team token) in token `shares` (backer Shares in hand) **or** token `team` (Team
   Shares in hand). The floor is **in Shares, not dollars**, so a fall in the Share's price never shuts a real holder out; it is there so that one wei
   moved over for the price of a fee does not open a seat. It is not a defence against someone who pays to hold more: those are held by the per-wallet cap,
   the rates, the mute that follows the wallet (step 7) and the operator. The same floor sets who is alerted (6.5). The balance table is as of the
   reader's last committed range, which is the final block (at least `BUZZ_CHAIN_CONFIRMATIONS` deep, 12 by default).
5. **A Team grant with something to claim.** If none holds in hand: the newest signed record of the project (kind 39009, signed by the server, `d` = the
   key) is read from the events table and `team.grants[]` is searched for a grant whose `member` is one of the wallets and whose **`claimable` is not
   `"0"`** (`vested - claimed`: the Shares still sitting in the Vester that the member may claim; RECORD-V2 line 189). It is **not** `vested`, which is
   "unlocked so far, claimed or not" (line 188): a member who claimed everything and then took out would keep a non-zero `vested` while the grant lives,
   and would write for ever with no balance and no end date. A cut grants list (`truncated`) that does not list the wallet is "does not hold" here, which is
   the safe side; a member who claimed their Shares holds in hand and is allowed by step 4 for as long as they hold them. Once the Shares are claimed and
   then taken out, `claimable` is zero and the grace of step 6 runs from the take-out.
6. **The grace after taking out (the "read-only one unit N after taking out" rule).** If none of the above holds: the time of the **latest decrease**
   of any of those wallets' balances for this project (a `chain_balance_changes` row with `delta < 0` for token `shares` or `team`, newest first;
   because the balance now is zero, that decrease is the one that emptied it) is read with its block time. The write is allowed while
   `lastDecreaseTime + unit > as_of`, where `unit` is the project's own time unit (from `ProjectLaunched.platform.unit`) and `as_of` is the newest block
   time the reader has stored (`AS_OF_SQL`; the chain's own clock, as the task rules use, so a test chain with a moved clock behaves). After that the
   person is **read-only**, with the sentence "not holding".
7. **Not muted by the team.** A `room-mute` (4.4) names a pubkey **and carries the wallet addresses that account had linked when the team signed it**
   (up to 8, a second tag kind, `["room-mute-wallet", "<address>"]`, read by the team's app from the person's kind 37017 records). The rule refuses the
   signer if the project's newest unexpired `room-mute` names the signer's pubkey **or any wallet the signer has bound** (step 3). So a muted person who
   signs a new key and links the same wallet is muted too and must hold with another wallet. (A person who really has two holding wallets is not stopped
   by a mute on one: said, and it is the team's to repeat.)
8. **Not too fast, and not too many voices.** At most 12 room posts and 60 room events (posts and likes) per account per hour and per day (counted from
   the stored events with this `room:` tag by this author); and **at most 5 accounts may write in a room through one wallet**: the number of live
   bindings of the wallet that matched in step 4 (a holder cannot be a crowd). Both are constants in the module.

Global bans, mutes and the timeouts of the whole server apply before all of this through `enforce_write_restriction`, unchanged.

**What the rule reads, how fresh, and what happens while the reader lags.**

| Read | From | Freshness |
|---|---|---|
| Holding now | `chain_balances` (the reader's committed balances) | The final block: `BUZZ_CHAIN_CONFIRMATIONS` (12) blocks behind the head. A person who backed seconds ago is **not yet holding here** |
| Vested Team grants | the newest 39009 record in the events table | At most the record's refresh age (600 s while money moves, 3,600 s otherwise) behind |
| The latest decrease and its time | `chain_balance_changes` + `chain_blocks` | The final block |
| The signer's wallets | the events table (kind 37017) | Immediate |
| The reader's clock | `AS_OF_SQL` (the newest stored block time) | The final block |

While the reader lags (a stalled node, a restart), the rule keeps deciding from the rows it has: **a person who holds in those rows is never shut
out by lag**, and a person who took out keeps writing for the unit N measured on the same chain clock (which does not move while the reader lags, so a
lag lengthens the grace and never shortens it). The one visible effect of lag is a person who backed seconds ago: they are refused with a
**"try again in a minute"** sentence and are let in once the reader has stored their Back. The rule is **never lenient** (unlike the task take, which
lets a take through while the reader lags): a room is not money, and a leaver or a stranger writing for a minute is a smaller harm than a rule that
trusts a person's word. A lookup that fails (a database error) refuses the write as a server fault, never lets it pass.

**4.2.1 The server's sentences** (the app maps each by its tail; the prefix is the relay's own: `restricted:`, `invalid:` or `retry:`):

| Where | Sentence |
|---|---|
| no reader | "restricted: rooms are not switched on on this server" |
| project not found, not listed or removed | "invalid: this project is not here" |
| tag or shape wrong | "invalid: a room post names its project and its room" |
| media | "invalid: the room is for text; leave out pictures and files" |
| launch not read yet | "retry: the server has not read this project yet; try again in a minute" |
| no linked wallet | "restricted: link your wallet to your account first, so the server can see that you back this project" |
| not holding | "restricted: only people who back this project can write in its room. If you just backed it, wait about a minute and try again" |
| muted by the team | "restricted: the team has stopped you writing in this room for now" |
| too fast | "restricted: you are writing too fast; try again in a few minutes" |
| too many accounts on one wallet | "restricted: too many accounts write from this wallet" |
| reply to something outside the room | "invalid: a reply belongs in the same room as the post it answers" |

**4.2.2 The wallet reader is shared (`handlers/wallet_binding.rs`, new, P2).** One function, `linked_wallets(state, tenant, pubkey) ->
Result<Vec<[u8; 20]>>`, and its inverse for P3's alerts, `accounts_of_wallets(state, tenant, &[[u8; 20]]) -> Result<Vec<(address, pubkey)>>` (bounded, one
SQL over kind 37017 with a `d` tag of any of the addresses). P3 imports both; neither is rewritten.

### 4.3 Reading the room, for anyone

Anyone who can read this server's posts reads the room with the filter of 4.1. **A visitor who is not a member on an invite-only server** reads it
through `api/public_read.rs` when the operator set `BUZZ_PUBLIC_PROJECT_READS`: P2 adds kind 1 and kind 7 **only when the filter names one project's
`#a` and the same project's `#t room:<key>`** (and kind 37021 for seasons, section 5), up to the file's existing bounds (6 filters, 200 per filter, a
limit per address, one shared budget a minute, the short cache). Posts and likes served this way are the stored ones whose signer is neither muted nor
banned (`Signers::shown`); a post the team or the operator removed is gone from the database's answer. It is never served for a project that does
not pass `public_standing`.

### 4.4 Report, mute, remove

- **Report** (any signed-in person, on any post): kind 1984 as built; the app offers five plain choices (section 7) that map to the existing types
  `spam`, `impersonation`, `profanity`, `illegal`, `other`. It goes to the operator's queue (`buzz-admin reports`) and nowhere else (NIP-56). **The
  team does not see reports** (they are never fanned out), so the team judges what it reads.
- **Hide this person** (a person's own mute, for them only): the private mute list (kind 10000, `social/mute/mute-list.ts`). The app drops that
  person's room posts from the person's own view. Undo is an "Undo" in the confirmation and the room's own "Hidden people" list (a short list of names with "Show again"; it
  is not on You). Nothing is sent to anyone.
- **Stop this person writing for a while** (the team): a kind 47003 record, a new family **`room-mute`**: tags `["a", coordinate]`,
  `["room-mute", "<pubkey hex>"]`, up to 8 `["room-mute-wallet", "<address>"]` (the wallets that account had linked, 4.2 step 7), `["expiration",
  <unix seconds>]` (NIP-40 style; at most 30 days ahead; one already past lifts the mute); signed by the founder or a team member the founder lists, under
  the existing team test in `launch_update_authority.rs` (a row is added to its table and to the module doc). The newest such record per person wins. Step
  7 of 4.2 reads them (the newest 200 `room-mute` records of the project). A team cannot mute the founder, the operator, or itself. **Said plainly:** the
  founder alone controls who is "the team" (the `team` tags on the founder's own record; there is no acceptance step), so a mute is the founder's tool, and
  a muted person keeps the right to read and to take money out.
- **Remove a post** (the team, in their own room): the existing kind 9005 request with no `h` tag and one `e` tag and a public reason
  (`handlers/home_moderation.rs`). P2 adds one authority: **the requester is the founder or a team member the founder lists on the project the post's `a` tag
  names, and the post carries that project's own `room:` tag.** The soft delete, the audit row and the public log entry (kind 45004, naming the author
  in `p`) are the existing transaction; a removed post is gone from every read. Because every reply and repost of a room post carries the room tag too
  (4.1), a reply is a post the team can remove; a like (kind 7) is not a post kind and is not removable, and a muted person's likes stop because their
  writes stop. The community's owners and admins keep their power over every post
  (unchanged). A team member cannot remove a post outside their room, a post by another team member of the same project (a guard rail like the
  board's: only the founder removes a team member's post) or an operator's.
- **The operator** removes a post as today; bans and mutes are the server's own.

### 4.5 Perks: text the founder sets

A perk is **words, never money**: "early looks at what the team is making", "a say in small choices that move no money", "your name in the release
notes". They are one new tag on the founder's project record (kind 37001): `["perks", "<text, at most 600 characters>"]`. **No edit flow for a project
record exists today** (`start-record.ts` only creates one; no sheet edits it), so A3 builds a small one: `room/perks-record.ts` reads the founder's
newest record, **copies every tag it has and its content**, sets or clears only `perks`, signs it and publishes it as the same replaceable record; its
test fails if any other tag (`d`, `chain-key`, `team`, `a`, the listing tags) is lost or changed. `room/PerksSheet.tsx` is the founder's sheet (words in
7.6, with a visible Close). **There is no word list**: a list of forbidden words is a false comfort (another client can write any tag) and a copy of a list
to keep right. The defences that hold: the fixed line under every perks text ("These are the team's own words. They are not money and not a promise of a
return."), the operator's power to remove a post and to take a project down, and the legal line unchanged. The relay only bounds the tag's length (its
existing record-size rule).

### 4.6 The manager's notices and task results

No new way to write. The room shows, **pinned at its top**, the team's newest notice (so a quiet room is never blank), and between the posts, **rows made from what the server already holds and the app already reads**: the team's own
update records (kind 47003 updates and weekly updates), the results a worker handed in (`task-result` tags on the hand-in step) and the check note the
AI manager wrote beside a task (the existing `check` body), each labelled "From the team" or "From the manager" (an account the server has on record as
a manager agent, `agent_label`) with its date. They are never signed by the room's writers and are never counted as posts. Task news that comes from
the network (planned, taken, ended) is the feed's (section 2.4) and the strips', not repeated here.

### 4.7 What a first-time visitor sees

On a phone, signed out or signed in but not holding: the project page's **Room** tab shows the room's header line ("Anyone can read this room. Only
people who back the project can write here."), the team's perks (if set), then the newest 30 posts and notices, and where a composer would be, a
**Back this project** button when the door is open (or the plain words for a shut door). Nothing is hidden behind an account. A person who holds sees a
composer, with "Posts and votes are public." under it. A person who took out within the unit N sees "You took out {when}. You can write here for {time
left}, then this room is read only for you." **The wallet link is part of Back, not a wall after it.** The room needs the person's wallet linked to their account (4.2 step 3), and a phone person has
never heard of linking. So the Back flow's last step (the receipt) links the account to the wallet that made the Back: **automatic for a passkey account
(one more touch of the device), one signature for a wallet** (A3: `room/use-link-after-back.ts`, called by `pot/BackSheet.tsx`). A person who backed is
already linked. The button **"Confirm this account backs the project"** stays only as a recovery for an old Back or a skipped step. When the server
answers "try again in a minute" the composer **keeps the draft and tries once more by itself after 30 seconds**. When the server cannot check a phone
account's link (its `/info` says `smartAccountLinks: false`, section 6.1) the room says so in plain words ("Rooms are not switched on for phone accounts on
this server.") instead of showing a button that cannot work. The words are in section 7.

---

## 5. Seasons and demo day (P2 records and rules; A4 screens)

Adjusted from `docs/PLAN-V2.md` section 5 to the new money model, where there are no rounds, no stages and no hand-back, and the door is always
open (or shut by its founder or by quiet). A **season** is a six-week group of projects with **open entry**, started by the platform's operator. **Demo
day** is the day a season's projects are shown together, each with its numbers and last update. **Creaton backing a project is an ordinary Back by
the owner and needs no code, no record, no matching pot** (a formula match can be farmed with one's own money: PLAN-V2 section 5).

### 5.1 The season record (the one new kind: `KIND_SEASON = 37021`, P2)

Parameterized replaceable, global (no `h`), `d = "season-<n>"` with `n` a decimal number from 1. Tags: `["d", "season-<n>"]`. Content (JSON, at most 1 KB):

```
{ "v": 1, "number": <n>, "startsAt": <unix>, "demoDayAt": <unix>, "endsAt": <unix> }
```

- **Signed by an operator only**: the pubkeys in `RELAY_OPERATOR_PUBKEYS`, or the relay owner when that list is empty (the same standing as
  `config.rs` documents). Anyone else: "restricted: only the people who run this server can start a season". P2 finds the existing helper that answers
  "is this key an operator"; no new list.
- **Rules at write**: `d` equals `season-<number>`; `startsAt < demoDayAt <= endsAt`; `demoDayAt - startsAt` from 1 day to 56 days; `endsAt - demoDayAt`
  at most 14 days; times are whole seconds not before 2020; one record per `number`. The operator's tool defaults are 42 days to demo day (six weeks)
  and 7 days of demo week after it (C10). **Dates may be changed by publishing the same `d` again** (a later record replaces it); entry and the
  pages always read the newest.
- **Why a new kind and not a tag**: an operator's statement about the platform belongs to no project, and every existing kind that is global and
  operator-signed is for something else. One kind, one rule at write (C10).
- **The number 37021 is not certain.** `docs/v3-review/COLD-START-PROPOSAL.md` (lines 448 and 467) lists 37021 to 37025 as free numbers for other
  records there. P2 checks `kind.rs` and that document before taking it, and the choice is recorded (C10); the owner may move it. A change is one constant and
  a regenerated table.

### 5.2 How a project enters (kind 47003, a new family, no new kind)

An **entry** is a team record about the project, like an update. Tags: `["a", "37001:<founder>:<id>"]`, `["t", "season-<n>"]`,
`["season-entry", "<n>"]`; content `{}`. **Signed by the founder or a team member the founder lists** (the same test as an update), so **a season cannot be entered for
someone else's project**: the rule reads the project record the `a` tag names as it stands and refuses a signer who is not on its team. A second
record, **`season-leave`** (same tags with `season-leave`), withdraws it. The newest of the two by `created_at` (then id) per project and season is the
project's state.

Rules at write (new, in `launch_update_authority.rs` calling `handlers/season_rules.rs`, P2): the season record `season-<n>` exists and `now` (the
server's clock) is in `[startsAt, demoDayAt)`; the project is **listed, not removed, launched on the network** (the reader has read its launch and
`projectId` ties to the coordinate, as in 4.2 step 2: a project with no money to show cannot be shown in a group of projects with numbers) **and has a
minimum bar**: the project's newest numbers record (read as in 4.2 step 5) shows `held.countedAccounts >= ENTRY_MIN_ACCOUNTS` (3), so a project nobody
backs cannot take a slot ("restricted: at least 3 people have to back this project first"; said: on a play network the bar costs nothing, so it is a hint
and the operator's removal below is the real brake); one live entry per project per season ("restricted: this project is already in this season"); **at most 500
entries per season** ("restricted: this season is full") and **at most 3 projects per founder per season**; and the entry's founder is neither banned
nor muted. **The count and the one-per-project check are made under one advisory lock per season** (`pg_advisory_xact_lock` on a hash of the season's
`d`, taken in the write's transaction), because a check followed by an insert over plain events is racy: two entries arriving together must not both
pass. Entry is **open**: no application, no review, no fee.

**The operator can remove an entry.** A record, family **`season-remove`** (kind 47003; the same `a` and `t` tags and `["season-remove", "<n>"]`),
**signed by an operator key only** (a row in `launch_update_authority.rs`'s table whose signer is the operator test of 5.1). It wins over any entry of that
project in that season, before or after (the project may not re-enter once removed), is public and dated, and is for junk and for what the operator must take
down. The CLI signs it (5.5).

Entries are read with `{"kinds":[47003], "#t":["season-<n>"], "limit":200}` **and paged**: the cap is 500, so the app follows `until` (the oldest `created_at` returned) while a page is full, at most 3 pages; the app re-checks every entry against the project's own record
(the signer is on its team: `projectVoices`; no `season-remove` names it), the same defence in depth the updates have. `public_read.rs` serves these two families (and kind
37021) to a visitor who is not a member, still one season per filter and bounded.

### 5.3 What Home and the demo day page show

**Home (A1 mounts a stub, A4 builds it): the season band**, one card under the welcome. By the newest season record and the clock:

| Now | The band says |
|---|---|
| before `startsAt` | "Season {n} starts {date}." |
| `startsAt` to `demoDayAt` | "Season {n} is open. Projects can enter until demo day on {date}." and, for a founder or team member of a launched project that has not entered, **"Enter {project}"**; for one that has, "{project} is in." and **"Leave"** |
| `demoDayAt` to `endsAt` | "Demo day: {k} projects show what they made." and **"See demo day"** |
| after `endsAt`, no later season | "No season is open. The last one ended {date}." and "See that demo day" |
| no season record at all | the band is not drawn |

**The demo day page** (`/season/$n`, A4): the season's number and dates; the projects that entered and were not removed, **in an order that is the same
for everyone and is not money, price, entry time or anything a project can change**: sorted by a hash of the season's number and the project's key (a pure
function with a test that it is stable and differs between seasons), so nobody has top billing for good; at most 24 at a time with "Show more". Each card
shows the project's name and line, "The project's money {amount}" (`money.pot`) and **its last update** (title and the first lines of the team's newest
update record, with its date); a project with no numbers yet says so. (No kept line, streak or chip on the card: the project page has them.) Under the
heading of the list, once: "This can go up or down. It is not a return." Under the list: the banner "You can take your money out any time. Nothing here
promises a profit.", the play-money line, and "Being on this page is not advice and is not a promise." The page is read-only: the only press is "Open
project".

### 5.4 Between seasons

Nothing runs by itself. After `endsAt` the band keeps linking to that season's demo day page (it stays readable for good: the records stay); a
project that entered keeps no special status, and a new season starts only when the operator signs the next record (2 minutes with the command below). If
the operator wants back-to-back seasons they sign season `n+1` with `startsAt = demoDayAt` of season `n`; entry for a project is per season.

### 5.5 The operator's command (`crates/buzz-cli`, P2)

`buzz launchpad seasons start --number <n> [--starts <rfc3339|now>] [--days 42] [--demo-week-days 7]`, `buzz launchpad seasons show`, `buzz launchpad seasons remove --number <n> --project <link ref>` (signs a `season-remove`), signing with the key
in `BUZZ_PRIVATE_KEY` as every `buzz` command does (the key is the operator's own; nothing is written to a file). It prints the three dates before it
signs and refuses a number that exists unless `--replace` is given. New file `crates/buzz-cli/src/commands/launchpad_seasons.rs`; the command table
line in `commands/mod.rs`; **the clap enum and the dispatch in `crates/buzz-cli/src/lib.rs`** (near the other `launchpad` commands), `crates/buzz-cli/src/help_tree.rs` and
`crates/buzz-cli/Cargo.toml` if a dependency is needed; tests next to it. (`buzz-admin` talks to the database directly and is for membership, communities and reports; a signed
record is the CLI's shape.)

---

## 6. Alerts away from the app (P3: web push) and the sponsored-fee limit

### 6.1 Off unless the operator turns it on

A server sends web push only when **both** of these are set in its environment (read at start, never from a file, never logged):

| Variable | Meaning |
|---|---|
| `BUZZ_WEB_PUSH_VAPID_PRIVATE_KEY` | the operator's own VAPID signing key (a P-256 private key, the 32 bytes as base64url) |
| `BUZZ_WEB_PUSH_SUBJECT` | the operator's contact for the push services (`mailto:` or `https:`), the `sub` of the VAPID token: the operator's own, not this project's |

Only one of them set is a startup error that names both (as `BUZZ_CHAIN_*` does: half a configuration is a mistake, not "off"). Neither set: **off**:
the information document (`/info`, `nip11.rs`) has no `webPush` key, `PUT /push/web` answers "not switched on", the sender is not started, the tables
are never written. Optional: `BUZZ_WEB_PUSH_DAILY_CAP` (alerts per device per UTC day, default 6, 1 to 50), `BUZZ_WEB_PUSH_MAX_PER_ACCOUNT` (devices per account,
default 5, 1 to 20), `BUZZ_WEB_PUSH_EXTRA_HOSTS` (exact `host[:port]` list of push endpoints allowed in addition to the known services, **for a local stand-in
only**; empty by default). The public half is derived from the private key and is the only thing published: `/info` carries
`"webPush": {"publicKey": "<base64url, 65 bytes>"}`. The app subscribes with it. Document these in `docs/web-push-deployment.md` (new, P3), **including that a push
service sees which devices are notified together and when** (it sees an encrypted message and a per-device keyed topic, never a name or an amount).

**`/info` also says whether this server can check a phone account's wallet link**: `"smartAccountLinks": true|false` (true when `BUZZ_EVM_AUTH` and
`BUZZ_EVM_RPC_URL` are both set, always present when a chain reader is configured; P3 adds it in `nip11.rs`). The app reads it so it can say "Rooms and
alerts are not switched on for phone accounts on this server" before a person tries, instead of showing a button that cannot work (A3, A4).

### 6.2 What is stored about a subscription (as little as possible, and deletable by the person)

`web_push_subscriptions`: `id`, `community_id`, `pubkey` (the account), `endpoint` (the push service's URL for this device: the browser's own
capability), `endpoint_hash` (sha-256, unique per account), `p256dh` (65 bytes) and `auth` (16 bytes) (the keys the browser made), `created_at`,
`expires_at` (90 days; the app asks again when a device is opened and the row is older than 30 days), `failures`. **Nothing else**: no user agent, no
address, no label, no project, **no wallet** (the wallet is looked up when an alert is made, never kept with the device), no list of what the person
holds. The person can delete their rows any time (`DELETE /push/web`, and the app's "Turn off" calls it and the browser's own `unsubscribe()`); a push
service answering "gone" (404 or 410) deletes the row; an expired row is swept. At most `MAX_PER_ACCOUNT` live rows per account (the oldest goes first).

### 6.3 The subscription paths (two HTTP paths, with the reason; C8)

`PUT /push/web` (body `{endpoint, keys: {p256dh, auth}}`) and `DELETE /push/web` (body `{endpoint}` or empty for all of the account's), both
authenticated like the server's other signed HTTP calls (NIP-98: the person's own key signs the request; verified with `crates/buzz-auth/src/nip98.rs` and its
replay guard `nip98_replay.rs`, as `api/self_serve.rs` does; **`crates/buzz-relay/src/nip98.rs` only signs outgoing requests** and is not the verifier), resolved to a community by host like
every API. The server checks: `endpoint` is `https`, at most 512 characters, **no credentials in it**, a host on the **known push services** list
(`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`) or on `BUZZ_WEB_PUSH_EXTRA_HOSTS`; **the host is
resolved at send time, an address that is private, loopback or link-local is refused unless that exact host is in the extra list, and the connection goes to the
address that passed the check** (the client is given it with `resolve`, so a name that changes its answer cannot pass the check and connect elsewhere) (so a person cannot
point the sender at the server's own network: C29); `p256dh` is 65 bytes starting `0x04` and **a point on the curve**; `auth` is 16 bytes. Rate: 10
requests an hour per account. The reason this is HTTP and not a signed event (R5 prefers an event): a subscription is **a bearer capability**, the
address that lets anyone send to that device, so it must not become a stored, public, fanned-out event; an event kind that is run and never stored is
possible (reports are) but needs a dispatch arm in the 11,000-line `ingest.rs` that P2 owns, and gains nothing for the one thing a person does here,
which is press a button and get an answer. The alternative is listed in section 11.

### 6.4 What is sent, and how it is encrypted

**The message** (the plain text the browser decrypts; at most 200 bytes): `{"v":1,"k":"planned"|"taken"|"ended","r":"<project link ref>"}` where the ref is
`<id>-<first 16 hex of the founder>` (the part of the link after `/p/`). **No amount, no name, no date, no project name.** The service worker turns the kind
into one of three fixed sentences (section 7) and opens `/you` (the news, which has the full words) when pressed. The details the in-app alert says
stay in the app: the push says only that there is news.

**The envelope.** RFC 8291 message encryption with the `aes128gcm` content coding (ECDH P-256 with the device's `p256dh`, `auth` as the secret,
HKDF-SHA-256, AES-128-GCM, a fresh random salt and ephemeral key per message, record size 4096) and RFC 8292 VAPID (`Authorization: vapid t=<ES256
JWT>, k=<public key>`; `aud` the endpoint's origin; `exp` at most 12 hours ahead; `sub` the operator's subject). Headers: `TTL: 86400`,
`Urgency: normal`, `Topic: <32 base64url characters of HMAC-SHA-256(k, endpoint hash ‖ project key ‖ serial)>` where `k` is derived from the VAPID private
key with HKDF and a fixed label (so a later alert about the same task replaces one this device has not received yet, **and no two devices carry the same
topic and nobody without the key can work it back to a project**: a plain hash of the project and the serial, which are public, would tell a push service
which project a device holds a stake in), `Content-Encoding: aes128gcm`. **No third-party web-push crate is in the lockfile**; P3 writes this on `p256`, `hkdf`,
`aes-gcm` (all three added as direct dependencies, section 1), `hmac` (a workspace dependency already), `jsonwebtoken` (ES256) and `reqwest`, in `web_push/ece.rs` and `web_push/vapid.rs`, **and proves it against RFC 8291 appendix A** (the RFC's own
fixed keys, salt and ciphertext: the unit test `rfc8291_appendix_a_vector` encrypts with the RFC's inputs and equals the RFC's bytes, and decrypts the
RFC's ciphertext), so no engineer's reading of the RFC stands alone.

### 6.5 When an alert is made and who gets it

**From the chain's rows, not from the record.** The alert maker is a step of the sender's own loop and reads `chain_logs` (role `tasks`, events
`TaskAnnounced`, `TaskTaken`, `TaskResolved`) from its own cursor (`web_push_cursor (reader, next_block)`), **only rows the reader has stored as final**.
**Where the cursor starts:** when push is first switched on (the table has no row for this reader), the cursor is set to **the reader's current final block
plus one**, in the same transaction that creates the row. Nothing before that is ever alerted: a cursor at 0 would send the whole history of every task to
every holder. A row whose block is older than the alert's own lifetime (the 24 hours of the `TTL` header) when it is picked up is dropped, not sent, whatever
the cursor says. Each row
makes at most one alert with the key `(reader, project, serial, kind)` (unique): `TaskAnnounced` is `planned`, `TaskTaken` is `taken`, `TaskResolved` is `ended`
(paid, sent back, lapsed or run out alike; the in-app `ran-out` is the same news). The same task and state makes the same id as the in-app alert, so a
person is not told twice in two voices. A withdrawn plan makes no alert, as in the app (it moved nothing).

**The audience, with no list of holders published or kept.** For one alert: the project's accounts that hold in hand, backer Shares or Team Shares
(`chain_balances`, `balance >= ROOM_MIN_SHARES` as in 4.2 step 4, the excluded contract accounts left out via `Ledger::excluded`), largest first, **at most 2,000** (a cut is counted and logged: those holders
have the in-app alert only); mapped to the accounts that **proved** the wallet with a kind 37017 record (`wallet_binding::accounts_of_wallets`); mapped to
the live subscriptions of those accounts in this community. **A subscription can never name a wallet or a project**, so it cannot be used to ask "does X
hold here?": an alert reaches only an account that proved the wallet itself. A person with no linked wallet gets no push and is told why in the opt-in
(section 7).

**The cap and the coalescing.** At most `DAILY_CAP` alerts per device per UTC day (counted from the outbox); more are written as `dropped` with the
reason `daily_cap` (a durable record, not a silence). At most 3 alerts per device per project per day. The `Topic` header coalesces at the push
service.

### 6.6 Retries, backoff and a terminal state (review rule 1 and 4)

`web_push_outbox (id, alert_id, subscription_id, state, attempts, next_attempt_at, lease_until, last_status, last_error, created_at, done_at)`, unique on
`(alert_id, subscription_id)`. States: `pending`, `sending`, `delivered`, `gone`, `dropped`, `failed`.

- **Atomic hand-over.** An alert's rows and the cursor move in **one transaction**: a crash between them repeats the alert's rows (the unique key
  absorbs them) and never skips one.
- **Claim.** The sender claims due rows with `FOR UPDATE SKIP LOCKED` and a lease (30 s), as the other outboxes do; a crashed sender's lease expires and the row
  is claimed again. One sender runs at a time per deployment (an advisory lock of its own); a second replica idles.
- **Result.** `201`: `delivered`. `404` or `410`: `gone`, and the subscription is deleted. `429`, any `5xx`, a network error or a timeout (10 s): retry; the
  pause is `60 s × 2^(attempts-1)`, at most 6 hours, and a `Retry-After` from the service is honoured up to that cap; **8 attempts, then `failed`
  (terminal; kept 30 days)**. `401` and `403` mean the operator's key or subject is wrong: the row is retried, a `warn` names the host, and after 3 such
  answers in a row from different devices the whole sender **pauses 15 minutes** (one error line, once, not one per device) so a wrong key does not
  spend the daily cap of every device. `413` and other `4xx`: `failed` at once. Delivered rows are kept 7 days (for the cap), then swept.
- **A rollback.** The reader stores only final rows, so an alert is never made from a block that can be undone; as a second line, a pass that finds the
  reader's cursor at or below an alert's block deletes that alert's rows that are still `pending` (nothing has left the server).
- **Never in front of money.** The sender is its own supervised task (started from `main.rs`, not inside the reader's pass): a push outage can never
  stall the reader or Take out.

### 6.7 The sponsored-fee limit (missing today; P3). It is never in front of Take out.

Checked: no sponsor service exists in the repository. `VITE_CREATON_SPONSOR_URL` is read by the app, and `PHONE-PATH-REPORT.md` says the limit "must be
enforced at the sponsor, or a thin service the operator runs in front of it". **P3 builds that thin service in the relay**, because it is a JSON-RPC over
HTTP by the protocol (`zd_sponsorUserOperation`), so it is an HTTP-only surface (C27): `POST /sponsor`.

**What the server can and cannot trust (the defect the review found).** The request is an unauthenticated JSON-RPC body and the `sender` inside it is a
public address anyone can name. A count per sender can therefore be run up by anyone against anyone, and the app retries a failed call (`aa.ts`, 3
attempts), so a limit placed in front of an exit would let a stranger use up a phone person's day or the server's day and stop them taking their money out.
That would break R6 and the owner's aim. So:

- **An exit is never refused by a limit and never counted against a person or the server.** The first cut decodes the call data (the Kernel account's
  single and batch `execute`, ERC-7579; `api/sponsor/calldata.rs`, held to `packages/creaton-core/src/aa/kernel033.ts` `decodeExecuteCallData` on the same
  bytes) into targets and 4-byte selectors. An operation is an **exit** when every call in it goes to a Treasury this reader follows and has the selector of
  `leave(uint256,uint256,address)` or `leaveTeam(uint256,uint256,address)` (the selectors are computed from those two signatures in the test and compared
  with the generated ABI, never typed). Exits count only against **one generous per-address cap** (`BUZZ_SPONSOR_EXIT_PER_IP_PER_DAY`, default 200), which
  an attacker spends on their own address; there is no per-sender and no server-wide cap on exits. The operator's own sponsor (the upstream) keeps its own
  spend cap, which is the last backstop and is named in `docs/web-push-deployment.md`'s sponsor section. A person with a little of the network's own gas
  can also take out directly (said in the app).
- **The request is pinned.** Only the method `zd_sponsorUserOperation`; a body over 32 KB, a batch (an array) or any other method is refused ("not
  allowed"); one operation per request. Without this `/sponsor` would be an open proxy to the operator's keyed upstream.
- **Off unless `BUZZ_SPONSOR_UPSTREAM_URL` is set** (the operator's real sponsor, which may have a key in its address: read from the environment, never
  written down, never logged; the app's own `VITE_CREATON_SPONSOR_URL` then names `/sponsor` on this server, which the app accepts because it has no
  key in it).
- **For every other operation (a Back, a claim, a send):** per sender per UTC day `BUZZ_SPONSOR_PER_ACCOUNT_PER_DAY` (default 10); a total for the whole
  server per day `BUZZ_SPONSOR_TOTAL_PER_DAY` (default 1,000), because a new passkey is a new account and a per-account limit alone can be farmed; and per
  client address per day `BUZZ_SPONSOR_PER_IP_PER_DAY` (default 40; the address by the same rule `public_read.rs` uses; shared carrier addresses can hit it,
  and exits are not affected by it). Table `sponsor_usage (day, key, count)`; a request **reserves** a count in the same statement that checks it, forwards to
  the upstream, and **releases the reservation if the upstream refuses or fails**. **Said plainly, a limit that stays:** because the sender is not
  authenticated, ten requests naming a victim's address can use up that person's day for **Back and the like** (not for exits). That is accepted: a Back
  can be made from a wallet, one attacker's reach is bounded by the per-address limit, and the limit exists to cap the operator's spend. An authenticated
  sponsor (NIP-98 plus a verified wallet link for the sender) is the later fix and is listed in section 10.
- **A refusal is worded for the app**: the JSON-RPC error message must contain one of `polic, denied, forbid, unauthor, not allowed, exceed, quota`
  (`app/.env.example` says so; the app turns those into "The free network fee was refused for this account, for example because today's free sends are
  used up"). P3 uses "daily limit exceeded" for the three limits and "not allowed" for a target that is not on the list; **a test reads the app's word
  list from its source and checks both sentences against it** (a number or a list that exists in two languages has one test that ties them, section 9.2 X3).
- **The allow-list of targets** (same decoder, so it is in the first cut): for a non-exit operation every call's target must be a contract this reader
  follows (`chain_contracts` of the reader: shares, team, treasury, vester, tasks, pair) or the dollar token or the Launcher; anything that cannot be
  decoded is refused ("not allowed"). An exit by definition decodes (the app builds its calls with the same encoder).
- Files: `crates/buzz-relay/src/api/sponsor.rs` (+ tests) and `api/sponsor/calldata.rs`, independent of the web push code; its table `sponsor_usage` is in migration 0074 beside the web push tables.

### 6.8 How it is tested with no real push service

- **The RFC vector** (6.4) pins the encryption and the VAPID token's shape (a token signed by the RFC 8292 example key verifies).
- **A local stand-in push service**, an `axum` server on `127.0.0.1:<random high port>` started by the test, whose address is put in
  `BUZZ_WEB_PUSH_EXTRA_HOSTS` for that test only. It is scripted per request: `201`, `404`, `410`, `429` with `Retry-After`, `500`, a slow answer, a
  refusal of the VAPID token. It **decrypts** what it receives with the key pair the test made (so the test reads the real payload), and checks the
  VAPID token against the public key. A second copy for the app lane: `scripts/web-push-standin.mjs` (Node, no dependencies), which `scripts/pot-full-loop.sh`
  starts and A5's journey reads.
- **Postgres tests** (ignored, serial): claim with a lease, a crashed lease reclaimed, backoff times, `Retry-After`, the terminal `failed`, the daily cap
  and `dropped`, `gone` deleting the subscription, the unique key absorbing a repeated alert, a rollback deleting pending rows, the cursor and rows moving together, **a fresh cursor starting at the final block (100 old task rows make no alert)**.
- **A real-relay loop** (P3's, `scripts/web-push-loop.sh`): the real relay with a real chain reader on a local chain, a task planned on the chain, a holder with a
  linked wallet and a subscription pointing at the stand-in, and the stand-in receives one decrypted `planned` message for that holder and none for a
  stranger or a leaver.
- No real push service, no real device and no real key are used anywhere in the repository's tests. Whether Chrome's, Firefox's and Apple's services
  accept this sender is **not proven here** and is the first human test (A5's report lists it).

---

## 7. Screens and every sentence of new copy (phone first)

**Rules for every screen below (A1 to A4).** Phone first: the design width is 360 px, a 16 px side gutter, no sideways scroll, one column; the same
screen is checked at 390 and 1,280 px. Text sizes are the rem tokens only (`pnpm check:px-text`). The product name comes from `APP_NAME`; people see
"Creaton". Plain words: "server" not "relay", "the project's money", "what you would get if you took out now", "Back", "Take out"; **no event names,
kind numbers, error names, "Shares as value", citations or competitor names in main copy** (`pnpm check:copy`; an allowlist entry needs a reason, and
the rule is to rewrite the text first). Never the word "earn" next to Shares. Every money screen says it is play money while the record's
`playMoney` is true or unknown. **New visual parts (review rule 7):** one owner per actionable label (a card is a region with a heading; a row is
one link or one button, never a link around a button); no duplicate screen-reader stops for one thing (a chip's meaning is its text, an icon is
`aria-hidden`); every input has a label; everything is reachable and usable by keyboard (Tab order is reading order; a sheet traps focus and returns
it); a ranked list is an `<ol>`; a live region says "Link copied." and similar once. Each new component has an axe test at 360 px and a keyboard test.
Every new screen is drawn **only where `investingOn()`** (the server says investing is on) and where the record has the keys it needs; trading stays
off. **Every input modality is a first-class seam (review rule 8):** the room's composer and its menus have a pointer test, a keyboard test (Enter posts,
Shift+Enter makes a line, Escape closes a sheet and returns focus, `Shift+Space` is never read as `Space`) and a touch test. New module-level caches go
into `resetCommunityState()` where the app has one; **the app has no community switching today (STEP2 report 6.3), so none is expected, and a reviewer
who finds a module-level `Map` or cache in the new code asks for it to move into a hook or a query.**

### 7.0 The banner and the line, on every page and sheet (A1)

Design 2.7 says the banner is "on every page and sheet", and the app has only the first half of it (`CAN_TAKE_OUT`, "You can take your money out any time.").
So A1 adds, once: the constant `TAKE_OUT_BANNER` = "You can take your money out any time. Nothing here promises a profit." in `pot/pot-words.ts` (word for word);
one component `app/src/app/MoneyBanner.tsx`, mounted by `app/src/app/Shell.tsx` after the page and above the tab bar **wherever `investingOn()`** (a page that
draws its own, the project page and the demo page, says so through a small context and the shell's one steps aside: never two on a page); and `PotSheet`
shows the whole banner in place of the first sentence only (`PotSheet` is the one sheet every money press goes through; the Share and Established sheets
use it or draw the constant). The sheets of the room's moderation (report, remove, mute, hide) show no money and carry no banner (a recorded choice, C38).
**"This can go up or down. It is not a return."** (`NOT_A_RETURN`) stands once, directly under the heading of every list or card that shows a live money
number: the ranking, the feed, the demo-day list, and under the project's money (7.1). A test (`app/src/app/banner.test.tsx`) walks every route and every
sheet that shows a money figure and fails when the banner or the line is missing, or when one route draws two banners.

### 7.1 The project page, one screen (A1: `project/ProjectTop.tsx` and its parts)

Top to bottom, in this order, all inside `ProjectPage.tsx`'s header region. **At 360 x 640 the name, the money with its line, "what taking out now would
give", the banner and the Back button are visible without scrolling** (a Playwright check; the earlier order put Back at row 11 and could not pass it). A
first-time visitor must get four things from this screen alone: what it is, the project's money, can I leave, and the press. Everything else sits below
the buttons.

| # | What | Sentence (the app's words; `{}` is a value) | Source |
|---|---|---|---|
| 1 | Name and the founder's line | the project's own words | project record (as now) |
| 2 | Chips (each one text, one stop) | "Established" (only when `established.reached`); "Open to back" or "Closed to new backers" | `established`, `door.openNow` |
| 3 | The project's money | label "The project's money", value in dollars; under it "This can go up or down. It is not a return."; then **"Taking out now would give {x} for each Share."** (the existing words of the Take out sheet for the same figure) | `money.pot`, `value.leaveValue`, `NOT_A_RETURN` |
| 4 | Play money | "This is a test network. The dollars are play money, not real money." | the existing `PLAY_MONEY_WORDS` |
| 5 | The fixed banner (a card, always) | "You can take your money out any time. Nothing here promises a profit." | `TAKE_OUT_BANNER`, word for word |
| 6 | The two presses | **"Back this project"** (the existing `BackCard`, moved here: its amount field, its sheet) and **"Share"** | step 1, A1 |
| 7 | Who | "{n} people back it." / "1 person backs it." / "Nobody backs it yet." | `holderCount` |
| 8 | How long money stays | "Kept {window} or more: {amount} by {n} people." / "Nobody has kept money in it for {window} yet." / "Too new to say how long money stays." (the project is younger than the window) | `held.rank`, `held.windows` |
| 9 | Updates | "Last update {when}." / "No update yet." and, from one week, "Updates: {n} weeks in a row" (`streakLine`, the shared words) | `clock.lastCheckIn`, `streaks.updates` |
| 10 | Planned tasks with a countdown | the existing strips (`PlannedStrips`), unchanged: "The team plans to pay up to … from {date}. You can take your money out before then." | tasks section (step 2) |
| 11 | Details (one fold) | "As of {time}"; the allowance ("The team may take up to {rate} of the project's money a day. Taken in the last day: {amount}.", `allowanceWords`); the door's words when shut (`doorShutWords`); "What “Established” means" | record |

`{window}` is the held window in plain words from `held.windows.rankSecs` (`spanWords`: "30 days"; on a test network with a short unit it reads in
minutes or hours, which is the point). `{when}` is `relativeTime`. An amount is `dollarsText`. Money figures follow the record's age rules (2.7 and
RECORD-V2 section 6): "(as of 14:05)" past 3 refresh periods, hidden past 24 hours with the existing sentence "We have not been able to refresh this
project's numbers since {date}. Your money is not affected: you can take it out any time."

**The Back box moves; it is not copied.** `BackCard` is drawn once, in row 6. The Money tab stops drawing it (A1 edits `ProjectMoney.tsx`), so there is
exactly one element named "Back this project" on the page (test A1-page). `BackSheet` is A3's file only for one line (it calls the link step of 4.7 when a Back lands). A signed-out visitor who presses it is asked to sign in or connect first, as now.

### 7.2 Share: the link and the picture (A1: `project/ShareSheet.tsx`, `share-card.ts`, `share-card-draw.ts`)

**The link is the existing one**, `{origin}/p/{id}-{founder}` (`projectPath`); the server already answers a crawler with a title, a line and a static
image that carry no amount (`share_preview.rs`), and that does not change. **The picture** is drawn on the person's own device on a canvas (1,200 x 630),
as a PNG, for the places that take a file. Sheet title **"Share this project"**; lines: "Anyone with the link can read the project. The link shows no amounts."
Buttons: **"Copy link"** (a live message "Link copied."), **"Share…"** (`navigator.share` with the link and "{name} on {APP_NAME}", only where it exists),
**"Share the picture"** / **"Save the picture"** (with the file where the browser can share files, otherwise a download). The picture has: the mark, the
name (two lines at most), the founder's line (three lines at most **and left off if it contains a currency sign, a percent sign or one of the words
price, gain, return, profit, worth, value**: a founder's own words can carry what the card must not), at most two facts ("Open to back", "{n} weeks of
updates in a row"), the fixed banner line, and "Play money on a test network." when the record says so. **No amount, no count of people, no gain
figure, no price.** (The server's link preview, `share_preview.rs`, shows the founder's own title and line as typed and is **not** filtered like the drawn card:
it carries no amount and no count, but a founder's own words are the founder's. Said here and in the report; not changed in this step.) The test `share-card.test.ts` records every string drawn and scans it (the banner line is removed before the scan, because it contains
the word "profit" in "Nothing here promises a profit"); the drawer takes any object shaped like a 2D canvas context, as the old `web/` card's test does.
Alt text: "{name}. {facts}".

### 7.3 "Established" (A1: `EstablishedChip.tsx`, `EstablishedSheet.tsx`)

The chip is drawn only when `reached` is true; it is a button whose text is "Established" and which opens a sheet. **Sheet title:** "What “Established” means".
Body: "Established is a hint. It is not a promise, and it changes nothing about your money." Then three lines, each with a tick or a dash that is also in words:
"Most of the money has stayed: {pct}% of it has been here {window} or more. It needs {need}%." · "At least {min} people back it: {n} do now." · "Two people run it." /
"One person runs it." The same sheet is reachable from Details for a project that is not Established, so the page never shames a young project: it says
what is missing in the same words ("Not yet: …"). `{need}`, `{min}` and `{window}` come from `established.rule` (nothing is typed in the app).

### 7.4 The ranking on Home (A1: `home/RankedSection.tsx`, `ranking.ts`, `use-ranking.ts`)

A section **"Money that stayed"** (not "Backers who stayed": the list ranks money, not people) between the projects you follow and "Shipping now" (which keeps
its newest-first order; the file's old comment "Never sorted by money" is rewritten to say that *Shipping now* is never sorted by money and the new section
is sorted by money that stayed, C20). It reads **the server's index of 2.8** (one record), not the 60 browsing records. Ordered list, at most 8, rule of 2.8,
re-sorted by the app. Directly under the heading, once: "This can go up or down. It is not a return." Each row is **one link** (the project's name) with its
line: "{amount} kept {window} or more by {n} people." and the Established chip as text only (the row link carries the meaning; the chip is not a second stop).
Footnote: "Ranked by the money that has stayed {window} or more, with the number of people beside it. It is not a price and not a promise." Once in the section: the
play-money line. Empty: "No project has money that has stayed {window} yet." A project not in the index, or whose record is missing, unlisted or removed, is not in the list,
and the footnote never claims the list is complete: "of the projects this server has numbers for".

### 7.5 The live feed and the streaks (A2: `feed/ProjectFeed.tsx`, `feed-rows.ts`, `feed-words.ts`; `pot/YourShares.tsx`, `pot/held-since.ts`)

A section **"Lately"** on the project page, under the top block and above the tabs, collapsed to its newest rows (a "Show earlier" press adds the next
ten). It leads with what lasts, and keeps the hours behind one press, so a small project's feed is never a wall of empty hours:

- **What happened** (items, newest first, 28 days): "A task was planned. It can be taken from {date}. You can take your money out first." · "A task was
  taken. It is due {date}." · "A task was paid." · "A task ended without being paid." · "A plan was withdrawn." · "The team posted its update." Each with its
  time ("{relative}"). Under the heading, once: "This can go up or down. It is not a return."
- **Last 2 days** (one line from the hour buckets, only when something moved): "Last 2 days: {j} backed, {t} took out." and a second sentence from the sum of
  the buckets' nets: "About {amount} more came in than went out." / "About {amount} more went out than came in." / "About as much came in as went out."
  **The two counts are drawn at the same size and weight in the same line; joins are not green and take-outs are not red** (a test compares the two
  elements' class lists). Never "volume", never a total of the two. A press, **"Show by the hour"**, opens the hour rows ("{hour label}: {j} backed, {t}
  took out." and the net sentence; hours with nothing are not drawn).

Under the title: "Amounts are rounded to the nearest {roundTo}. No names are shown." (`roundTo` from the record, "100 dollars"). Empty: "Nothing has
happened here lately." Absent or old feed: not drawn (2.7). The play-money line is the page's (row 4 of 7.1).

**Your weeks held.** In "Your position" (`pot/YourShares.tsx`), one line when the person holds: "You have held it for {n} weeks." (n is whole units since the
person's balance last became positive and stayed so), or "You backed {when}." when it is under one unit. Worked out on the device by `pot/held-since.ts`
from the person's own Transfer logs (2.5); if the read fails the line is not drawn (never "0 weeks"). **No reward, no points, no "keep it going".** The
line is also in the room's header for the person writing.

### 7.6 The holder room (A3: `room/**`)

The page's fifth tab, **"Room"**, drawn when the project has a chain key and investing is on.

| Where | Sentence |
|---|---|
| Header, always | "Anyone can read this room. Only people who back the project can write here." and "Posts and votes are public." |
| Perks (when the founder wrote some) | heading "Perks from the team"; the text; under it "These are the team's own words. They are not money and not a promise of a return." |
| Founder's edit sheet (`PerksSheet`) | label "What do people who back this get?"; hint "Say it in words, for example early looks at what you are making. Do not promise money."; buttons "Save" and "Close" (no word list: 4.5) |
| Composer (a person who may write) | label "Write to the people who back this"; placeholder "Say something"; button "Post"; under it "Posts and votes are public." and "The team can remove posts. Be kind." |
| A person who may not write, signed in or out | "Only people who back this project can write here." and the **"Back this project"** button when the door is open (the door's words when it is shut) |
| Signed in, holds, wallet not linked (recovery only: Back links it, 4.7) | "To tell that you back this project, the server needs this account confirmed." and **"Confirm this account backs the project"**; for a passkey account it is one touch of the device |
| Link about to end (from 30 days before) | "Your wallet link ends on {date}. Confirm it again to keep writing here." and the same button |
| The server cannot check phone accounts | "Rooms are not switched on for phone accounts on this server." (no button) |
| A person inside the unit after taking out | "You took out {when}. You can write here for {left} more, then this room is read only for you." |
| Muted by the team | "The team has stopped you writing here until {date}. You can still read, and you can take your money out any time." |
| Just backed, server not caught up | "Not ready yet. Try again in a minute." The composer keeps the draft and tries once more by itself after 30 seconds |
| Each post | the person's name and time (the existing byline), the text, and three actions **named with the author** so a screen reader hears different things: "Like {name}'s post", "Reply to {name}", "More actions for {name}'s post" (a menu) |
| "More" menu, for everyone | "Report" and "Hide {name}'s posts" |
| "More" menu, for the team | "Remove this post" and "Stop {name} writing here" |
| Report sheet | title "Report this post"; one choice of "Spam", "Pretending to be someone", "Rude or harmful", "Illegal", "Something else"; button "Send report"; after: "Thanks. The people who run this server will look at it." |
| Hide confirmation | "You will not see posts by {name} any more. Only you stop seeing them." with **"Undo"**; the room's own "Hidden people ({n})" row lists them with "Show again" |
| Remove sheet (team) | title "Remove this post"; label "Say why. Everyone can see the reason." (at most 280 characters); button "Remove"; failure "The post was not removed. Try again." |
| Mute sheet (team) | title "Stop {name} writing here"; choice "1 day", "7 days", "30 days"; "They can still read. You can lift this any time."; button "Stop writing" |
| Notices (the team's newest pinned at the top, the rest between posts) | label "From the team" or "From the manager"; the update's title and first lines, or "Work handed in: {title}", with its date |
| Empty | "Nothing here yet. People who back this project can write the first post." |
| Read failed | "The room could not be read. Try again." |
| Server's refusals (the app maps by the sentence's tail) | the sentences of 4.2.1 in plain words: wallet not linked (above), not holding (above), "You are writing too fast. Try again in a few minutes.", "Too many accounts write from this wallet.", "A reply belongs in the same room as the post it answers.", "The room is for text: leave out pictures and files." **On any refusal the composer keeps what was typed** (the mention-editor contract) |

**Every sheet of the room** (Report, Remove, Mute, Hide, Perks, Confirm) has a visible **"Close"** (or "Not now") button as well as Escape: touch has no Escape. **The Room tab carries a "New" dot** when the team or anyone posted since the person last looked (kept on this device only, in `room/room-seen.ts`, every read and write inside `try`, never a module-level cache; a device that cannot keep it shows the dot, never hides news).

Room posts **never appear** in Home's "Recent posts", in a person's profile posts, or in the Updates tab's "posts about the project" (A3 filters on the
`room:` tag in `use-posts.ts` and `use-project.ts`: the room is read in its own tab, **replies and likes included, by the room tag only**, so an untagged event can never show in a thread; the engagement read by `#e` is filtered the same way). Likes and replies in the room carry the room
tag (A3 adds an optional `room` argument to `buildPost`, `buildReply` and `buildVote` in `packages/creaton-core/src/social/feed/feed-events.ts`; the
old `web/` callers pass none and are unchanged).

### 7.7 Seasons and demo day (A4: `season/**`)

The sentences are in 5.3. Buttons: "Enter {project name}", "Leave", "See demo day", "Open project", "Show more", and "Close" on every sheet. One button per project, each with the
project's name in its label (so two projects of one founder are two distinct, named presses). Refusals, in the app's words: "This project is already in
this season." · "This season is full." · "This season is not open for new projects now." · "Only the team can enter a project." · "The project has to be open
to backers first." · "At least 3 people have to back this project first." · "You have already entered 3 projects in this season." · "This project was taken out of the season by the people who run this server." · "Not ready yet. Try again in a minute."

### 7.8 Alerts away from the app (A4: `alerts/push/**`, `you/YouPage.tsx`, `public/sw.js`)

A card on You, in the news section, **drawn only when the server's information document carries `webPush`** (the server says nothing otherwise, and the
card is not drawn: the app never invents a way to switch alerts on).

| State | Sentence and press |
|---|---|
| Heading | "Alerts when you are away" |
| Explained, off | "Get a short message on this device when a task is planned, taken or ended on a project you back. It says nothing about amounts or names. Open the app to read the news." and **"Turn on alerts"** |
| Needs a wallet link | "To tell which projects you back, the server needs this account confirmed." and **"Confirm this account backs the project"** (the same recovery as the room; a person who backed already has it); when `/info` says `smartAccountLinks: false` for a phone account: "Alerts are not switched on for phone accounts on this server." (no button) |
| Asking the browser | the browser's own permission prompt (never shown before the person pressed the button) |
| On | "Alerts are on for this device." and **"Turn off"** |
| Turning off | "Alerts are off. What the server kept for this device is deleted." |
| Blocked in the browser | "Alerts are blocked for this site in your browser settings." |
| Cannot show alerts here | "This browser cannot show alerts. On an iPhone, add the app to your Home Screen first." |
| Server error | "Alerts could not be turned on. Try again." |
| Always, small | "Alerts may arrive late or not at all. The news on this page is always the full story." and "You can turn alerts off any time." |

**What the device shows** (the three fixed sentences in the service worker; title **"News about a project you back"** for all, with no product name in it
because the worker file is plain and the brand constant is a build value): planned "A task was planned on a project you back. You can take your money out
first." · taken "A task was started on a project you back." · ended "A task ended on a project you back." Pressing it opens You (the news, which has the
project, the amounts and the way out). A message of an unknown kind or a bad shape is dropped without showing anything. The worker never shows a
name or an amount because the message never carries one.

---

## 8. The work packages (eight engineers, two lanes)

The machine is shared (4 CPUs, about 6.5 GB free): one heavy build or test at a time per person, `nice -n 10 timeout 1500`, `CARGO_BUILD_JOBS=2
CARGO_INCREMENTAL=0` for cargo, `bash …/waitbusy.sh` before every forge or cargo command, a random high port for every anvil, relay, preview or stand-in, and stop
each before finishing. Estimates (engineer-days, a guess, raised after review): P1 10 (the index and the SQL bound), P2 10, P3 13 (the call-data decoder is now first), A1 9 (the banner), A2 5, A3 13 (the
room is the biggest app package: the composer, the cards, the menus, report, hide, remove, mute, perks, the link step and the mute list, none of which exist
in the app today), A4 8, A5 6: about 74 engineer-days (the design gave step 3a 3 engineer-weeks and step 3b's alerts part of 4.5, and both were low, as step
2's figure was: C32). **The server engineers go one after another, P1 then P2 then P3** (one Rust build on a shared 4-CPU box at a time); the two lanes run in
parallel with each other.

### 8.1 Ownership (one owner per path; a change to another's path is asked of the owner and waits for their commit)

| Package | Owns (exact) | Does not touch |
|---|---|---|
| **P1 Reader and record** | everything in 3.1: `crates/buzz-relay/src/chain_reader/{held.rs, record_social.rs, record_social_tests.rs, held_postgres_tests.rs, explore.rs, explore_tests.rs, explore_postgres_tests.rs, ledger.rs (the one function), record.rs, numbers.rs, mod.rs, testdata/pot-run.json}`; `migrations/0073_chain_held_indexes.sql`; `schema/tables/public/{chain_balance_changes.sql, chain_blocks.sql, chain_project_numbers.sql}`; `scripts/chain-reader-fixture.py`, `scripts/chain-reader-example-check.py`, `scripts/chain-loop-pot.sh`, `scripts/chain-loop-pot-check.py`; `docs/next-version/{RECORD-V2.md, record-v2-example.json, READER-V2-REPORT.md}` | `handlers/**`, `api/**`, `app/**`, `packages/**`, `schema/schema.sql`, `schema/seeds/**`, `crates/buzz-db/**` (no new table) |
| **P2 Room and season rules** | `crates/buzz-core/src/kind.rs` (`KIND_SEASON`); **both generated tables**, `packages/creaton-core/src/kinds.generated.ts` **and `mobile/lib/shared/kinds.g.dart`** (`just regen-kinds` writes both: `scripts/regen-kinds.mjs`; regenerated, never typed; the mobile CI sees a new constant only); `crates/buzz-relay/src/handlers/{room_write.rs, room_write_postgres_tests.rs, wallet_binding.rs, wallet_binding_postgres_tests.rs, season_rules.rs, season_rules_postgres_tests.rs, launch_update_authority.rs, launch_update_authority_postgres_tests.rs, home_moderation.rs, home_moderation_postgres_tests.rs, ingest.rs, mod.rs}`; `crates/buzz-relay/src/api/public_read.rs` and `api/public_read/postgres_tests.rs`; **`crates/buzz-cli/src/{lib.rs, help_tree.rs, commands/launchpad_seasons.rs, commands/mod.rs}` and `crates/buzz-cli/Cargo.toml` (only if a dependency is needed)** with the tests; `docs/next-version/ROOM-AND-SEASON-RECORDS.md` (new: the normative tags, rules and sentences of sections 4 and 5, written first on P2's first day) | `chain_reader/**`, `app/**` |
| **P3 Push and the sponsor limit** | `migrations/0074_web_push_and_sponsor.sql`; `schema/tables/public/{web_push_subscriptions.sql, web_push_cursor.sql, web_push_alerts.sql, web_push_outbox.sql, sponsor_usage.sql}` and **everything a new table needs to be registered**: its `\i` lines in `schema/schema.sql`; for each operator-global table (`web_push_cursor`, `web_push_alerts`, `sponsor_usage`: keyed by reader, project or day, not by community) a row file `schema/seeds/<table>.sql` and its name in the two lists of `crates/buzz-db/src/runtime/migration.rs` (which classifies every table and fails a test on an unclassified one); for each community table (`web_push_subscriptions`, `web_push_outbox`: they carry `community_id`) a `schema/triggers/<table>.sql` with `SELECT attach_community_write_fence('<table>');`; and the line in `scripts/reconcile-schema-after-pgschema.sql` only if a table needs one (P1 added no table, so these are P3's alone); `crates/buzz-relay/src/web_push/**` (`mod.rs`, `settings.rs`, `hosts.rs`, `ece.rs`, `vapid.rs`, `store.rs`, `alerts.rs`, `sender.rs` with their tests and `*_postgres_tests.rs`); `crates/buzz-relay/src/api/{web_push.rs, sponsor.rs, sponsor/calldata.rs, mod.rs}`; `crates/buzz-relay/src/{router.rs, main.rs, lib.rs, config.rs, nip11.rs}` (the new lines only; `nip11.rs` adds `webPush` and `smartAccountLinks`); `crates/buzz-relay/Cargo.toml`, `Cargo.toml`, `Cargo.lock` (the direct dependencies `p256`, `hkdf` and `aes-gcm` are added: they are transitive today; `hmac` is already a workspace dependency; checked offline first); `scripts/{web-push-standin.mjs, web-push-loop.sh}`; `docs/web-push-deployment.md`; `app/.env.example` (the sponsor lines) | `chain_reader/**` (P3 only **reads** `chain_logs`, `chain_balances`), `handlers/**` (P3 imports `wallet_binding`; it does not edit it) |
| **A1 The page, the card, the badge, the ranking, the banner** | `app/src/features/money/{numbers-social.ts, numbers-types.ts, numbers.ts}` and their tests; `app/tests/helpers/numbers-v2-fixture.ts` (additive: a `withSocial` patcher and a labelled `shape-only` index until P1's is generated); `app/src/features/pot/{pot-words.ts, PotSheet.tsx, ProjectMoney.tsx}`; `app/src/app/{MoneyBanner.tsx, Shell.tsx, banner.test.tsx}`; `app/src/features/project/{ProjectPage.tsx, ProjectTop.tsx, project-top-words.ts, EstablishedChip.tsx, EstablishedSheet.tsx, ShareSheet.tsx, share-card.ts, share-card-draw.ts}`; `app/src/features/home/{HomePage.tsx, RankedSection.tsx, ranking.ts, use-ranking.ts}` (`use-home.ts` stays as it is); the **three stubs** (below); `app/scripts/check-copy.mjs` (append-only, below); `app/tests/e2e/pot-page.spec.ts` | the files of A2 to A4 |
| **A2 Feed and streaks** | `app/src/features/feed/**` (overwrites the `ProjectFeed.tsx` stub); `app/src/features/pot/{YourShares.tsx, held-since.ts}` and tests; `app/tests/anvil/held-since.test.ts`; **`scripts/pot-app-loop.sh` for one line: the loop names its anvil test files one by one, so A2 adds `tests/anvil/held-since.test.ts` to that list and A5 owns the file after A2's commit**; `app/tests/e2e/pot-feed.spec.ts` | |
| **A3 The room** | `app/src/features/room/**` (overwrites the `RoomTab.tsx` stub; new there: `PerksSheet.tsx`, `perks-record.ts`, `use-link-after-back.ts`, `room-seen.ts`); `app/src/features/posts/{use-posts.ts, Composer.tsx, PostCard.tsx}` (the room tag, the "More" menu with author-named actions, the draft kept on a refusal); `app/src/features/pot/BackSheet.tsx` (**one call** to `use-link-after-back`); `app/src/features/project/{use-project.ts, project-record.ts}` (the room filter, the perks tag); `packages/creaton-core/src/social/feed/feed-events.ts` and its `.test.mjs` (the optional `room` argument); `app/src/features/team/{use-wallets.ts, LinkWallet.tsx}`; `app/src/features/money/passkey-sender.ts` (`signsMessages`); `app/src/lib/mutes.ts` (**new**: no mute UI or wiring exists today, `packages/creaton-core/src/social/mute/mute-list.ts` is not used by the app, so A3 builds the wiring, the "Hidden people" list and the Report call); `app/tests/e2e/pot-room.spec.ts` | |
| **A4 Seasons and push opt-in** | `app/src/features/season/**` (overwrites the `SeasonBand.tsx` stub); `app/src/app/router.tsx`; `app/src/features/alerts/push/**`; `app/src/features/you/YouPage.tsx`; `app/public/sw.js`; `app/tests/e2e/{pot-seasons.spec.ts, pot-push.spec.ts}` | |
| **A5 Joined-up loops and the report** | `app/tests/e2e-pot-full/{pot-room.spec.ts, pot-seasons.spec.ts, pot-push.spec.ts, world.ts}`; `scripts/{pot-full-loop.sh, pot-app-loop.sh}`; `scripts/check-cross-language.mjs` (new: the three ties of 9.2 X3 between Rust, `sw.js` and the app); `app/tests/anvil/` additions the loops need; `docs/next-version/STEP3-REPORT.md`; the final run of everything | everything else |

**The three stubs** (created by A1 on its first day so `ProjectPage.tsx` and `HomePage.tsx` compile and mount them once; the later package **owns and
overwrites** the file, and the export's name and props do not change): `features/feed/ProjectFeed.tsx` (`ProjectFeed({ numbers, project })`, A2),
`features/room/RoomTab.tsx` (`RoomTab({ project, numbers, profiles, team })`, A3), `features/season/SeasonBand.tsx` (`SeasonBand()`, A4). Each stub returns
`null` and carries a one-line comment naming its owner. **The only files two packages touch** are these three (A1 creates, one later package owns), the reader files P3 only reads, and **one append-only shared file, `app/scripts/check-copy.mjs`**: A1 to A4 each add their own reasoned allowlist entries at the end of the list and change no other line (safe because the app lane is serial; a rewrite of the text comes before an entry). A path handed on in a row above (`pot-app-loop.sh`) changes hands only after the first owner's commit. A package never edits a generated file by hand (`events_table.rs`, `views_table.rs`,
`kinds.generated.ts`, `pot-run.json`, `record-v2-example.json`, `abis.generated.ts`): it runs the generator.

### 8.2 Order, and what each needs from the others

Two lanes in parallel; **inside the server lane one engineer at a time (P1, then P2, then P3)**, so there is one Rust build on the shared 4-CPU box. Dates are
engineer-days from the start, a guess.

| When | Package | What lands | Needed by |
|---|---|---|---|
| Days 0 to 3 | P1 **M1** | the record types, the builders, the fixture run with transfers, **the first generated example with the four keys** | A1, A2 (the real shape instead of guesses) |
| Days 3 to 4 | A1 | the three stubs; the `shape-only` social fixture and index (labelled) | A2, A3, A4 |
| Days 3 to 12 | A1 | the parser, the banner, the page top, the share sheet, the chip, then the ranking (against P1's real index from day 10) | A2 to A5 |
| Days 3 to 10 | P1 **M2** |  the Postgres query and indexes, the falsifiable bound, the checks and the nulling, **the index record**, the Python check, the spec | A1 (the ranking), A5 |
| Day 10 | P2 | **first day: `docs/next-version/ROOM-AND-SEASON-RECORDS.md`** and `KIND_SEASON` with both regenerated tables | A3, A4 (the exact tags and sentences) |
| Days 10 to 20 | P2 | the room rule, `wallet_binding`, the season rules and the operator family, the families, removal, public reads, the CLI | A3, A4, A5; **P3 imports `wallet_binding`** |
| Days 12 to 17 | A2 | the feed, own streak (the anvil test needs the real contracts) | A5 |
| Days 17 to 30 | A3 | the room (builds against P2's spec from day 17 and its rule from day 20), the link step in Back, the passkey link, perks, report, hide, team tools | A5 |
| Days 20 to 33 | P3 | settings and tables (20 to 23), the subscription paths and the info keys (23 to 25), the alert maker and the sender (25 to 29), the stand-in and the loop (29 to 30), the call-data decoder and the sponsor limits (30 to 33) | A4 (opt-in from day 25), A5 |
| Days 30 to 38 | A4 | seasons (needs P2), the opt-in and the service worker (needs P3's paths from day 25) | A5 |
| Days 38 to 44 | A5 | the loops and the report; every package fixes what the loops find | the lead |

The two things that must not slip: **P1 M1's example** (day 3) and **P2's spec document** (its first day). If either is late, the app lane keeps building against
labelled `shape-only` fixtures and the join is the first test run: a mismatch is a bug in the fixture, never a reason to hand-copy a number.

### 8.3 Checks each package runs before it hands over (nothing is "done" on green CI alone: each runs the thing)

| Package | Commands (repository root, Hermit active) | And exercises |
|---|---|---|
| P1 | section 3.3 | the example block against `cast` for one account's held figure |
| P2 | `cargo test -p buzz-relay --lib room_write wallet_binding season_rules launch_update_authority home_moderation public_read`; the Postgres tests (`-- --include-ignored --test-threads=1 room_write_ wallet_binding_ season_rules_ launch_update_authority_ home_moderation_ public_read`); `cargo test -p buzz-cli launchpad_seasons`; `cargo clippy -p buzz-relay -p buzz-cli --all-targets -- -D warnings`; `cargo fmt -- --check`; `just regen-kinds` leaves no diff; `scripts/check-postgres-test-discovery.py` | a real relay with a fixture chain read: every refusal of 4.2.1 and 5.2 over the wire with a real signed record, a holder, a stranger, a leaver inside and outside the unit (the chain's clock moved), and a season started, entered and left with the real command |
| P3 | `cargo test -p buzz-relay --lib web_push sponsor`; the Postgres tests (`web_push_`, `sponsor_`); clippy, fmt; `scripts/web-push-loop.sh`; `docs/web-push-deployment.md` read end to end against `settings.rs` | the relay with keys set and with none (off: no `webPush`, the paths refuse, the task not started), the RFC vector, the stand-in receiving a decrypted message |
| A1 | `pnpm -C app test -- src/features/money src/features/project src/features/home src/features/pot src/app`; `pnpm -C app check`; `pnpm -C app test:e2e pot-page`; `node scripts/pot-app-abi.mjs --check` | the page at 360, 390 and 1,280 px, keyboard only, the accessible names read from the DOM, the banner on every route and sheet |
| A2 | `pnpm -C app test -- src/features/feed src/features/pot`; `scripts/pot-app-loop.sh` (the held-since test on the real contracts); `pnpm -C app check`; `pnpm -C app test:e2e pot-feed` | the same, and the feed against the example regenerated by P1 |
| A3 | `pnpm -C app test -- src/features/room src/features/posts src/features/team src/features/project`; `pnpm -C packages/creaton-core test`; `pnpm -C app check`; `pnpm -C app test:e2e pot-room` | the room as a holder, a stranger, a leaver and the team (mock mode), by pointer, keyboard and touch |
| A4 | `pnpm -C app test -- src/features/season src/features/alerts src/features/you`; `pnpm -C app check`; `pnpm -C app test:e2e pot-seasons pot-push`; the service worker's own test | the opt-in with a fake push manager (no real push service exists in a test browser) |
| A5 | `scripts/pot-app-loop.sh`; `scripts/pot-full-loop.sh`; `scripts/chain-loop-pot.sh`; `scripts/web-push-loop.sh`; `scripts/phone-loop.sh`; `node scripts/check-cross-language.mjs`; `pnpm -C app check`; `cd web && pnpm check:unused` (knip); the full Playwright `smoke` project; the build with the bundle-size check | the whole thing in a browser against a real relay and chain; the bytes Home reads for the ranking (2.8: the index and the project records it names) |

Rust rules of AGENTS.md hold for P1 to P3: no `unsafe`, no new `unwrap()` or `expect()` in production paths, doc comments on new public API, fmt and clippy
clean. The app rules hold for A1 to A5. `just ci` before the pull request; the human steps of the pull request checklist (a person tries it) are
not skipped and are not marked by an engineer. Commits: `git -c user.name=… -s`, small and finished, files added by exact path, never push, never
switch branch, never stash or reset, never create a worktree.

### 8.4 For each package: what it builds, what it reuses, what it needs

| Package | Builds | Reuses (section 1) | Needs from the others |
|---|---|---|---|
| P1 | `held`, `feed`, `streaks`, `established` in the record; **the signed ranking index (`d = explore`) and the five columns behind it**; two indexes; the fixture's transfers; the Python recomputation; the spec | `project_logs` rows, `chain_balance_changes`, `chain_blocks`, `store::balances`, `numbers::build`, `validate`, `facts_of`, `publish::publish`, `task_chain`'s tie, the fixture and example generators | nothing; the app lane waits for its M1 example |
| P2 | the room rule, the shared wallet reader, the season record and entry rules, team removal and mute, public reads of room and seasons, the operator's command (start, show, remove), the operator's season-remove, the room events that answer a room post, the normative spec | `task_chain.rs`'s tie and `AS_OF_SQL`, `launch_update_authority.rs`'s table, `home_moderation.rs`'s transaction, `public_read.rs`'s bounds, `enforce_write_restriction`, kind 37017's ingest check, the reports queue | nothing; its spec document on day 1 is what A3 and A4 build from |
| P3 | web push (settings, tables, subscription paths, info keys, alert maker, sender, crypto, stand-in) and the sponsor limits with the call-data decoder | the chain reader's rows, `wallet_binding` (P2), `crates/buzz-auth/src/nip98.rs`, the helper's retry patterns, `main.rs`'s spawn pattern, the crates in the lockfile (three become direct dependencies) | P2's `wallet_binding` (done at day 20); the reader's tables as they are |
| A1 | the parser for the new keys, the banner and the line on every page and sheet, the one-screen project page, the share sheet and card, the chip, the ranking from the index, the three stubs | `numbers.ts`, `BackCard`, `PlannedStrips`, `pot-words.ts`, `PotSheet`, `Shell`, `project-record.ts`, `streakLine`, `share_preview`'s link, the example and the index (P1) | P1 M1 and M2 |
| A2 | the feed, the person's own weeks held | `own-history.ts`'s log reading, `YourShares.tsx`, `relativeTime`, the example | A1's parser and stub; P1 M1 |
| A3 | the room, the report, hide and team tools, perks and their edit flow, the wallet link inside Back, the passkey link, the mute list wiring, the room tag in the builders | `PostCard`, `PostPage`, `Composer`, `use-posts.ts`, `mute-list.ts`, `LinkWallet`, `use-wallets.ts`, `kernel-signature.ts`, the REPORT types | P2's spec and rule; A1's stub |
| A4 | the season band and demo day page, entry, the push opt-in, the worker's handlers | `projectVoices` (the re-check), `readMulti`, the news section and `You`, the existing `sw.js` and its registration | P2's season rules; P3's `webPush` in `/info` and the subscription paths (from day 25, done by day 33); A1's stub |
| A5 | the three joined-up journeys and the report | `scripts/pot-full-loop.sh`, `world.ts`, the real relay and chain, P3's stand-in and loop | every package |

---

## 9. The attack list and the test list

### 9.1 What builders and reviewers hold against (each: the defence, and the test that fails without it)

| # | Attack | Defence | Test |
|---|---|---|---|
| 1 | A team member or stranger **fakes the badge** (Established) | The verdict is worked out by the server from chain rows and signed by the server's key; the app believes only that signer; a team member cannot edit it. Faking the inputs needs real Shares: each fake account must hold at least the smallest Back for the whole window (2% fee on a real network, nothing on play dollars: said, "a hint"); moving Shares between one's own accounts cannot raise `held` (2.2). It unlocks nothing | H1, H2, E1 to E3, A1-badge |
| 2 | **Fakes the ranking** with wash trades or many accounts | Same inputs; a transfer into an account starts that account's clock at zero and lowers the sender's minimum, so the total only falls; selling and buying back lowers it; the account count counts only accounts above the smallest Back; the rule never reads the pot, price or volume. **The list is the server's index, built from all launched projects and tied to each project's coordinate, so a founder's edit time or word decides nothing and sixty junk records push nobody out.** Said: about 250,000 one-wei moves in 91 days make a project's `held.badge` null (a missing badge or row, nothing else; 2.2.1) | H2, H7, H9, IX1 to IX4, A1-rank |
| 3 | **Fakes the feed** or reads who moved money | No per-event row, no name, no address; hour buckets; net rounded to 100 on the bucket; volume is not published (no bucket carries both sides; a one-sided bucket's net equals its volume to within 50 dollars, which the public chain shows already); the chain itself is public and the feed adds nothing a reader of it cannot see. A wash join and take-out in one hour shows two counts and a net near zero | F1 to F5 |
| 4 | **Fakes a streak** | The project streak is check-ins on the chain, which only the runner (or a Pair signer) can make; a junk check-in each week keeps it (the design's known weakness: the manager flags an empty record) and **it is display only**. A person's own weeks held come from their own chain history and cannot be published by anyone | S1 to S4, A2-streak |
| 5 | **Writes in the room without holding** (a stranger, a person with no linked wallet, a wallet with no Shares, a wallet with one wei, someone else's wallet, an expired or revoked link, **an untagged reply or like to a room post**) | The rule reads the signer's verified bindings and the reader's balances above a floor in Shares; a binding is verified when stored (a wallet signature or the chain's answer for a smart account) and its expiry and chain are read now; the tag's key must equal the named project's `chain-key`; **an event that names a stored room post is a room event whatever tags it carries (4.1), so it must carry the room tag and pass the same rule**; a person's word (a tag, a profile, a post) changes nothing | R1 to R5, R9, R10, R16, R17, R24 |
| 6 | **One holder, many voices** | At most 5 accounts may write through one wallet; at most 8 wallets are read per account; rate limits per account | R13, R14 |
| 7 | **A holder shut out of the room while they hold** | A holder in the reader's rows is allowed whatever the lag; a person who took out keeps the unit N, measured on the chain's own clock (a lag lengthens it); a person who backed seconds ago gets "try again in a minute", not a refusal that reads as final; the rule never depends on a list someone edits. **Said plainly: a team can mute a holder for up to 30 days at a time and can do it again; the team is whoever the founder lists, so the founder decides; it cannot touch their money, and leaving and reading stay open.** The mute is a public, dated, time-bounded record, **and it follows the wallets the muted account had linked, so a new key on the same wallet is muted too** | R6 to R8, R15, R25 |
| 8 | **A leaver keeps writing** | The grace ends N after the decrease that emptied the balance; a Team grant counts only while its **`claimable`** is non-zero, not its `vested` (a member who claimed everything and took out has `vested` > 0 and `claimable` = 0) | R6, R5b |
| 9 | **Names or amounts leak** | The four record keys carry no address and no per-account figure (a test walks the JSON); the feed and the picture round and aggregate; a push message carries no amount, name or date and is encrypted to the device; the project's own streak is not a person's; **a push Topic is a keyed hash per device, not a hash of public values** (a push service must not learn which project a device holds) | F5, P11, P12, A1-card |
| 10 | **Push used to spam** | Alerts are made only from chain task rows, never from text anyone writes; one per task and state; at most 6 a day per device and 3 per project per device, the rest written as `dropped`; 5 devices per account; a withdrawn plan makes none; a message never repeats because of a retry (unique key) | P7 to P10, P13 |
| 11 | **Push used to learn who holds what** | A subscription names no wallet and no project; an alert goes only to an account that proved the wallet with a verified binding; an attacker with their own subscription learns only their own holdings; the push service sees only an encrypted message and a per-device keyed topic (timing remains visible to it and is said in the operator's page) | P8, P12 |
| 12 | **A subscription pointed at the server's own network** (SSRF) | https only, no credentials, a known push-service host or an operator-listed one, the address resolved at send time, refused when private, loopback or link-local unless the host is in the operator's list, **and the connection made to the address that passed**; the body is bounded; no redirect is followed | P4 |
| 13 | **A season entered for someone else's project** | The entry must be signed by the founder or a team member the founder lists on the project its `a` tag names, read from the project record as it stands; the app re-checks the signer against the project's own team before it lists an entry; a non-operator cannot sign a season record | M1, M3, A4-season |
| 14 | **A season filled with junk** | Listed, launched on the network, **at least 3 counted accounts (a hint-level bar)**, one entry per project, 3 per founder, 500 per season **checked and written under one advisory lock per season**; **the operator can remove an entry (`season-remove`)**; the demo page lists 24 at a time in a stable hashed order | M2 to M6, M9, M10 |
| 15 | **Perks that promise money** | The fixed disclaimer under every perks text, the operator's removal and takedown powers; the relay bounds only length. **No word list** (a false comfort, and a second list to keep right). **A founder with another client can still write any text** (said) | A3-room |
| 16 | **The team removes a critical post** | Public reason (at most 280 characters) and a public log entry naming the author; the operator sees the log. A team's room is the team's to keep; the money is not | R19, R20 |
| 17 | **The sponsor is farmed, or turned against a phone person** | Per account, per server and per address limits per UTC day on non-exit operations, the reservation released when the upstream refuses; the allow-list of targets; the method pinned, the body capped, batches refused. **An exit (`leave`, `leaveTeam`) is never counted or refused by the per-account or server limit**, because the `sender` is unauthenticated: anyone could otherwise name a victim and stop them taking out | K1 to K9 |
| 18 | **A room post tagged for another project's room** | The `room:` key must equal the chain key of the project the `a` tag names | R10 |
| 19 | **A rollback or reorg changes who holds** | Only final rows are read (12 blocks deep by default); alert rows still pending are removed if the cursor falls below their block | P14, H8 |
| 20 | **A failed read becomes "nobody" or "zero"** | A new key is `null`, never `0` or `[]`; a database error in a rule refuses the write; the sender keeps a durable retry record | V2, V3, R21, P9 |
| 21 | **Push replays history** | The alert cursor starts at the final block when push is first switched on; a row older than the alert's own lifetime is dropped | P7b |
| 22 | **A project's `held` is made to look worse by dust** | Counted in SQL with the cap inside the read; a cut makes only that window's key null and is counted; said (2.2.1) | H4, H9 |

### 9.2 The tests (each guard has one that fails without it; it is switched off once and the result written in the report: review rule 3)

**P1, the record** (unit tests in `record_social_tests.rs`, built from the fixture's rows and run; Postgres in `held_postgres_tests.rs`):

| Id | What it holds |
|---|---|
| H1 | an account that held 40, dipped to 10 for an hour and returned to 40 counts 10 (the minimum, not the end balance) |
| H2 | random sequences of transfers between accounts: `held(window)` never rises when Shares move, never exceeds `held(smaller window)`, and equals the supply at a window of zero |
| H3 | `held_at_zero_window_is_the_supply` (2.6) |
| H4 | the bound: exactly `HELD_ROWS_MAX` rows in a window gives a value, one more makes **that window's key** null and the other window still stands; more than `HELD_ACCOUNTS_MAX` accounts the same (Postgres, with the two limits passed in small so the table stays small) |
| H5 | three cases of the badge from one fixture run at three named blocks: reached; below 60%; fewer than 10 accounts; and a Pair with the same signer twice is not "two signers" |
| H6 | `rank.money` equals `mulDiv(shares, leaveValue, 1e18)` |
| H7 | an account below the smallest Back is not counted |
| H8 | the query reads only rows at or below the final block; a rollback past a change removes it (Postgres) |
| H9 | **the bound is real (falsifiable):** a table of 1,000,000 change rows for other projects and 5,000 for this one (made with `generate_series`, dropped after the test; check `df -h` first); `EXPLAIN (ANALYZE, FORMAT JSON)` of the query shows the scan under the `LIMIT` reads at most `rows_max + 1` rows of this project and **no row from before the window's first block**; the test fails when the `LIMIT` is moved after the running sum or the block lower bound is removed (it is switched off once and the result written in the report). An `EXPLAIN` on a small table would pick a sequential scan and prove nothing, so it is not used |
| H10 | the SQL's per-account figures equal the pure walk of `lowest` over the same rows, on random sequences (Postgres against the unit function) |
| F1 | 48 buckets, aligned, quiet hours present as zeros, the last holds `asOf.time` |
| F2 | rounding half up on the bucket net: a single 40-dollar join reads `even`; exactly 50 rounds up; the sum of a bucket's moves is rounded once, never per event |
| F3 | the feed's keys are exactly the listed ones (no in-and-out pair, no volume) |
| F4 | a `TeamLeft` counts as a take-out; counts have equal weight in the record |
| F5 | **no address-shaped string and no per-account figure appears anywhere in the four new keys** (a JSON walk over the example and over a record with 200 holders) |
| F6 | items: the six kinds only (no rate or wind-down item), dates (`noticeEnd` for planned, `deadline` for taken), newest first, the cut of 30 and `cut` |
| S1 to S4 | consecutive launch-aligned windows; the open window being empty does not end the streak and a closed empty one does; **two passes at different `asOf` inside one window give the same value** (a sliding anchor would flap); a project that checks in every 10 days shows fewer weeks (stricter than the contract, said); `longest` |
| E1 to E4 | the rule on its own inputs; `twoSigners`; the constants in the record equal the server's; `held: null` gives `reached: null` |
| V1 | `validate` refuses a record whose `reached` contradicts its inputs |
| V2 | a failing social check nulls that key only; the money fields are signed |
| V3 | a database error in `held_input` gives `held: null` and a signed record |
| V4 | `facts_of` strips the four keys: a sliding window alone does not re-sign |
| X1 | the example equals the server's output; `scripts/chain-reader-example-check.py` (an independent Python recomputation) agrees on every new field |
| IX1 | `explore_of`: the order rule (money, accounts, older, key); a project with `held.rank` null or money zero is absent; at most 20, `seen` and `cut` right |
| IX2 | (Postgres) only `NOT stale` rows are read; a project whose record's coordinate does not hash to its `projectId` is left out; a record that claims another project's key is left out |
| IX3 | (Postgres) the index is signed by the relay key with `d = explore`, republished only when the entries change and not oftener than 600 s; a failing build keeps the old index and counts `explore_failed` |
| IX4 | the index carries no address, name or per-person figure and no price field (a JSON walk) |

**P2, the rules** (`*_postgres_tests.rs` with real signed events; the pure parts as unit tests):

| Id | What it holds |
|---|---|
| R1 to R5 | no linked wallet; a linked wallet with no Shares; **a wallet with one wei (below the floor) is refused and one at the floor is allowed, for both tokens**; a holder; a Team Share holder in hand; a Team grant with `claimable` non-zero (a grant with `vested` non-zero and `claimable` zero is refused) |
| R5b | **a Team member who claimed all and then took out** (`vested` still non-zero, `claimable` zero) is refused once the grace of R6 has passed |
| R6 | a person who took out writes while `lastDecrease + unit > as_of` and is refused after it (the chain's clock moved with the fixture's tool) |
| R7 | a person whose Back is not stored yet gets the "try again in a minute" sentence, and is allowed once the reader stores it |
| R8 | with a reader that has stopped (stale `as_of`), a holder in its rows is still allowed (no shut-out by lag) |
| R9 | an expired attestation and a revoked binding are not wallets |
| R10 | a `room:` key of another project, and an `a` tag of another project, are refused |
| R11 | media tags and a body over 2,000 characters are refused |
| R12 | a reply whose root is not a room post of this room is refused; **a reply or like or repost to a stored room post that carries no room tag, or another room's, is refused** |
| R13, R14 | the hourly and daily limits; the sixth account through one wallet |
| R15 | a team mute holds until its expiry, a past expiry lifts it, a non-team signer's `room-mute` is refused at ingest, the founder cannot be muted; **a new account bound to a muted account's wallet is refused too (R25)** |
| R16 | no reader configured: "rooms are not switched on" |
| R17 | **an untagged reply by a stranger to a room post is refused** (replaces the earlier "never reaches the rule" test, which asserted the hole); an ordinary kind 1 with no room tag and no `e` tag naming a room post never reaches the rule (a counter on the rule stays zero, so no ordinary post is slowed) |
| R18 | `public_read`: a filter without both `#a` and `#t room:` gets the membership refusal; a project that fails standing yields nothing; a muted signer's posts are not served; bounds and the shared budget hold |
| R19, R20 | the team removes a room post of its own project (a stranger, another project's team and a team member removing the founder's post are refused); the public log entry exists and names the author |
| R21 | a database error during the rule refuses the write |
| R22 | a binding on another chain than the reader's is not a wallet; an attestation expiring in 29 days still counts and is flagged for renewal |
| R24 | a stranger's like (kind 7) and repost to a room post without the room tag is refused; with the tag and no holding, refused with the not-holding sentence |
| R25 | the mute names the wallets: a muted person's second account that binds the same wallet is refused; an unrelated wallet is not |
| M1 | a non-operator season record is refused; an operator's is stored; bad dates are refused; a replacement wins |
| M2 | entry before `startsAt` and from `demoDayAt` is refused; inside is accepted |
| M3 | an entry signed by a stranger, or for another founder's project, is refused; by the founder or an accepted member, accepted |
| M4 | an unlaunched project, an unlisted one and a removed one are refused; **a launched project with fewer than 3 counted accounts is refused** |
| M5 | a second entry is refused; leave then enter again works; the newest by `created_at` and id wins; **an operator's `season-remove` wins over entry and over a later entry, and a non-operator's is refused** |
| M6 | 500 per season and 3 per founder; **600 entries sent at once (concurrent transactions) store exactly 500 and no project twice** (the advisory lock) |
| M7 | `public_read` serves season records and the two entry families, one season per filter, bounded |
| M8 | the command prints the three dates before it signs, refuses an existing number without `--replace`, signs the record the rule accepts, and `seasons remove` signs a `season-remove` the rule accepts |

**P3, push and the sponsor** (`web_push/*_tests.rs`, `*_postgres_tests.rs`, `api/sponsor.rs` tests):

| Id | What it holds |
|---|---|
| P1 | `rfc8291_appendix_a_vector`: the RFC's inputs give the RFC's bytes and the RFC's ciphertext decrypts |
| P2 | a VAPID token verifies with the public key; `aud`, `exp` (at most 12 h) and `sub` are as set |
| P3 | one variable of the two set: startup error naming both; none: off (no `webPush` in `/info`, the paths refuse, the task is not started) |
| P4 | each bad subscription is refused: not https, credentials in the address, a host not listed, a private or loopback address at send time, a point off the curve, a wrong `auth` length, an address over 512 characters |
| P5 | at most `MAX_PER_ACCOUNT` devices; the oldest goes; 10 requests an hour |
| P6 | the paths need a signed request; `DELETE` removes the account's rows (or one endpoint's) |
| P7 | one alert per `(project, serial, kind)`; the cursor and the rows move in one transaction (a stop between the two repeats and never skips) |
| P7b | **a fresh cursor starts at the final block: a reader with 100 old task rows makes no alert, and one row after the cursor makes one; a row older than the alert's lifetime is dropped** |
| P8 | the audience: a linked holder yes; a stranger, a leaver and a holder with no linked wallet no; 2,000 at most and the cut counted |
| P9 | `201` delivered; `410` gone and the subscription deleted; `429` with `Retry-After` honoured; `500` and a timeout back off by `60 × 2^(n-1)` seconds capped at 6 h; 8 attempts then `failed` and kept 30 days |
| P10 | the daily cap writes `dropped` with its reason; 3 per project per device |
| P11 | the stand-in decrypts the message: its keys are exactly `v`, `k`, `r` and it is under 200 bytes; no amount, name or date |
| P12 | two devices get different topics for one alert; one device gets the same topic for the same alert; the topic is not a plain hash of the project and the serial |
| P13 | repeated `401` or `403` pause the whole sender 15 minutes once, with one error line |
| P14 | a rollback below an alert's block deletes its pending rows and leaves delivered ones |
| P15, P16 | the sender is not started when off; with two replicas only the lock holder sends |
| K1 to K3 | per account, per server and per address limits on **non-exit** operations, each answered with "daily limit exceeded" (a word the app's list accepts) |
| K4 | the reservation is released when the upstream refuses or fails |
| K5 | no upstream set: the path is absent |
| K6 | the call-data decoder agrees with `decodeExecuteCallData` on the same bytes (single and batch); a target off the list is refused with "not allowed"; the two exit selectors equal the generated ABI's (**in the first cut**) |
| K8 | **an exit is never counted and never refused by the per-account or server limit, even with both used up; it counts only against the per-address exit cap** |
| K9 | **ten requests naming a victim's `sender` with a non-exit call use up that sender's day and leave the victim's exit working** (the limit that stays, and the exemption that keeps leaving open); a method other than `zd_sponsorUserOperation`, a batch array and a body over 32 KB are refused |
| K7 | the upstream's address never appears in a log line or an answer |

**The app** (vitest unless named; each fails with its guard off):

| Id | What it holds |
|---|---|
| A1-parse | the example parses with all four keys; **each key hostile, wrong or missing reads as that part `null` and the money record still parses**; an older record shows no social part |
| A1-page | the banner word for word; "This can go up or down. It is not a return." under the money; the play-money line; **exactly one "Back this project"**; **at 360 x 640 the name, the money with its line, "Taking out now would give {x} for each Share.", the banner and Back are in view without scrolling (Playwright)**; axe |
| A1-banner | `banner.test.tsx`: every route and every sheet that shows a money figure draws the banner and the line exactly once; a route that draws its own does not get the shell's; the sentences equal the constants |
| A1-badge | the chip only when reached; the sheet's three lines from `rule`; keyboard open and close; no second stop |
| A1-card | every string drawn is scanned by the forbidden pattern (banner removed first); a pitch with a currency sign or a gain word is left off; alt text; the link equals `projectPath` |
| A1-rank | the order rule (money, accounts, older, key) **applied by the app to a shuffled index**; a project with a huge pot and no money that stayed is not listed; an index not signed by the relay's key, or older than 24 hours, shows nothing; an entry whose project record is missing, unlisted or removed is dropped; **the key function reads no price field (the index carries none)**; an `<ol>`; one link per row; "Shipping now" keeps its order; the line "This can go up or down. It is not a return." under the heading |
| A2-feed | the items' words (six kinds); "Last 2 days" counts have the same class list and weight; the three net sentences; the hour rows behind "Show by the hour"; no name; rounding words from `roundTo`; empty; absent and old |
| A2-streak | `held-since` from a person's own logs on the real contracts (anvil): a take-out to zero resets it; a transfer in does not extend it; a failed read draws nothing |
| A3-room | a stranger: read-only and Back; a holder: composer and "Posts and votes are public."; every server refusal mapped to its words **and the draft kept**; a just-backed person gets "Not ready yet. Try again in a minute." and one automatic retry after 30 s; report; hide with Undo and "Hidden people"; team remove and mute; **actions named with the author** ("Like {name}'s post"); **every sheet has a visible Close**; the perks sheet keeps every other tag of the record (**fails if any tag is lost**) and shows the fixed line; **room posts, replies and likes are not in Home, the profile or the Updates tab, and an untagged event never shows in a room thread**; the "New" dot; pointer, keyboard (Enter, Shift+Enter, Escape, `Shift+Space`) and touch; axe |
| A3-link | a Back that lands links the account (a passkey account signs with `signKernelHash` and is accepted; a wallet signs once) with no extra screen; the recovery button words; the renewal line from 30 days before; with `smartAccountLinks: false` the plain words and no button |
| A4-season | the band's five states from the clock; entry and leave; refusals in words; demo day in the hashed order (stable, different between seasons, never by money or entry time), 24 at a time, **an entry whose signer is not on the project's team is not listed and a `season-remove`d project is not shown**; paged entries (3 pages at most) |
| A4-push | the card's states from the table of 7.8; the subscribe body; turning off deletes and unsubscribes; hidden without `webPush`; the service worker (loaded in a vm) shows only the three sentences, drops anything else, opens You; no amount or name can reach it |
| A5 | the joined-up journeys (section 8.1): room, seasons, push against the stand-in; the bytes Home reads |
| X3 | `scripts/check-cross-language.mjs`: the room's 2,000-character limit equals the app's `MAX_POST_CHARS`; the alert kinds planned, taken and ended are the same in the Rust alert maker, `app/public/sw.js` and the app's push words; the sponsor refusal words the Rust side uses are all in the app's list (`app/.env.example` and the code it reads). Each is a number or a list that exists in two languages, so each has one test that ties them |

---

## 10. Not in this step

- **Email** is declined, recorded: it would mean holding people's addresses; web push keeps only a device's own capability (6.2).
- **A native phone push for this app** (the Buzz mobile app's NIP-PL path to an iOS gateway is untouched and is not the Creaton app).
- **An authenticated sponsor.** A NIP-98-signed `/sponsor` request plus a verified wallet link for the `sender` would let per-account limits be exact and
  would close the one limit that stays (6.7: a stranger can use up a victim's day for a non-exit operation). It needs the app's account client to sign
  each request and is a later step.
- **A "This week" line on You** (a summary of updates and tasks on projects a person backs): the in-app news and the
  room's "New" dot cover the weekly reason to come back without more reads on You.
- **Room extras**: pictures, files, voice, direct messages, polls, votes that decide anything (there is no vote: design 1.2), team-only rooms, push for new
  posts (it would be spam), threads' own alerts.
- **Rewards**: points, an airdrop, badges for streaks, anything unlocked by a streak, any ranking by price or volume, any money tied to live attention.
- **Seasons**: a prize, a matching pot (farmable with one's own money; PLAN-V2 section 5), automatic seasons, a ranking inside a season, Creaton's own
  backing as code (it is an ordinary Back by the owner).
- **Per-person rows anywhere** in the record, the feed, the push or the card; **per-event amounts** in the feed.
- **Proof against the real push services** (Chrome's, Firefox's, Apple's): no real service or device is used in any test. The first human test.
- **Phone passkey accounts reaching the room and alerts without a chain connection on the server**: a passkey account's link is checked by asking the
  chain (`BUZZ_EVM_AUTH` and `BUZZ_EVM_RPC_URL`); without them the link is refused, `/info` says `smartAccountLinks: false` and the app says so in words before the
  person tries (A3-link, A4-push).
- **Real money**: unchanged; off until the outside audit and counsel (JOIN-LEAVE-DESIGN sections 8 and 12). Nothing here changes a contract, a money rule or
  the legal line. Whether rooms and rankings fit the line is added to counsel's list by the owner; **I did not reword anything**.
- The human tests of the pull request checklist are not done and are not marked.

---

## 11. Chosen under the owner's standing go; the owner may overrule

Each choice, with what the alternative would have been.

| # | Choice | Alternative |
|---|---|---|
| C1 | The room is kind 1 and kind 7 with one tag, decided by a rule on write; **not** a NIP-29 channel or a forum board | Channels with a member list kept by a job that follows transfers (a lag is a person shut out or let in) |
| C2 | The tag is `["t", "room:<chain key>"]` beside the project's `a` tag, because the relay filters on single-letter tags only | A multi-letter tag (not filterable in one read); a new kind (a new kind for what kind 1 already is) |
| C3 | May write: holds Shares or Team Shares in hand now **above a floor in Shares (0.001 of a Share)**, or has a Team grant with something left to claim (`claimable`, not `vested`), or took out within one unit N (on the chain's clock); decided from the reader's final rows; never lenient; a lag lengthens the grace and refuses a person who backed seconds ago with "try again in a minute" | Allow while the reader lags (lets a stranger in); no grace (a leaver loses the room at once); read the chain per write (a node call in front of every post); `balance > 0` (one wei opens a seat); a floor in dollars (a price fall shuts a real holder out) |
| C4 | A linked wallet is required (kind 37017, verified when stored, expiry and chain read now); at most 5 accounts per wallet, 8 wallets per account; **a team mute follows the wallet**; the link is made inside Back | Trust a claim in a post (a person's word); one account per wallet (a phone and a laptop of one person); a mute by key alone (a new key defeats it); a link button after Back (a wall on the main path) |
| C5 | A passkey account's wallet link is built in A3 with the tested `signKernelHash`, so a phone person can write and be alerted; it needs the server's chain connection | Leave phone people out of the room and alerts until a later step (the people who most need alerts) |
| C6 | Perks are a `perks` tag (600 characters) on the founder's project record, with a money-word speed bump in the app and a fixed disclaimer | A new record family with history (more machinery for text); a server-side word filter (a second copy of a list, and a false comfort) |
| C7 | The manager's notices and task results are rows made in the app from records the app already reads; no new write path and no server-signed room post | A server-signed notice kind (a new signer and kind for what exists) |
| C8 | Web push subscriptions are `PUT` and `DELETE /push/web` signed per request, because a subscription is a bearer secret that must not become a stored or public event | A never-stored command kind with one more arm in `ingest.rs` (works; one more shared hot file for no gain) |
| C9 | A push says only "news" in one of three fixed sentences; its message carries a kind and the project link; only chain task rows make alerts; only planned, taken and ended | A message with names or amounts (a leak); an alert for each room post (spam); claims by push (they stay in the app) |
| C10 | Season record is the one new kind, 37021 (**the number is listed as free for other records in `docs/v3-review/COLD-START-PROPOSAL.md`: the owner may move it**), signed by an operator; entry is a tag family on 47003 signed by the project's team, **with a bar of 3 counted accounts, an advisory lock per season, and an operator's `season-remove`**; six weeks (42 days) to demo day and a 7-day demo week as the operator's tool defaults; entry open until demo day; 500 entries a season, 3 per founder | A tag on an existing kind for the season (it belongs to no project); an application and review (not "open entry"); seasons made by the server itself (it would need a calendar and a key); no bar and no removal (a few keys could fill 500 slots) |
| C11 | `held` is the sum over accounts of the lowest balance in the window; money by the record's own per-Share figure; an account counts when it holds at least the smallest Back | The age of the oldest Share (can be farmed by splitting); a figure that repeats the contract's formula (a second copy of it) |
| C12 | **The ranking is the server's signed index** (kind 39009, `d = explore`, at most 20 entries, built from five columns the reader keeps and tied to each project's coordinate); Home reads that one record. **Reverses the first plan**, which ranked the 60 browsing records Home already reads: that is ordered by a founder's edit time, lets a founder stay in or push others out, and is too heavy for a phone | Rank the 60 browsing records in the app (the first plan; a founder's word decides who is eligible) |
| C13 | The feed is hour buckets of counts and a net rounded half up to 100 on the bucket; items for what is not money; no per-event row | Per-event rows with rounded amounts (a row is a person's move); round per event (the sum drifts) |
| C14 | A project's streak is the number of consecutive launch-aligned windows of one unit, newest first, with a check-in; the open window may be empty; stricter than the contract's 2-unit rule on purpose | Windows anchored at `asOf` (they slide and flap); the contract's 2-unit rule (a "week" would not mean a week); calendar weeks (they depend on a time zone); the founder's own record dates (a person's word) |
| C15 | A person's weeks held are worked out on their own device from their own chain history | A per-person row in the record (R2 forbids it) |
| C16 | A failure in a new key makes that key `null` and signs the rest; **this differs from step 2**, where any task failure fails the whole build, because the task section protects holders from a hidden plan and these keys protect no one | The same rule as step 2 (a ranking bug would freeze a project's money figures) |
| C17 | The Established thresholds (60%, 13 units, 10 accounts, two signers) are server constants carried in the record | Constants in the app (a copy) |
| C18 | The chip is shown only when reached; the sheet and Details say what is missing for any project | A "Not established" label (it shames a young project) |
| C19 | The picture is drawn on the person's device; the server's link preview is unchanged | A server-drawn image per project (an image library in the relay for a card that already carries no amount) |
| C20 | Home gets one new section, "Money that stayed", ordered by money that stayed; "Shipping now" keeps its recency order | Re-sorting Home by money (against PLAN-V2 section 6); "Backers who stayed" (it reads as a list of people) |
| C21 | Every new screen is drawn only where `investingOn()`; push only where the server advertises `webPush` | Always on |
| C22 | The Back box moves to the top of the project page and leaves the Money tab (one named press) | Two Back boxes (two stops for one thing) |
| C23 | The room is read publicly through the existing public-read path, only per project and only with its own tag | A new public path |
| C24 | Room limits: 12 posts an hour, 60 events a day per account; 5 accounts per wallet | Larger or no limits |
| C25 | Text only in the room (no media tags, 2,000 characters) | Pictures with a scan (a moderation burden this step cannot carry) |
| C26 | Push: 6 a day per device, 3 per project per device, 5 devices per account, backoff `60 × 2^(n-1)` s to 6 h, 8 attempts, 30 days of failed rows | Other numbers |
| C27 | The sponsored-fee limit is built as `POST /sponsor` in the relay, off unless an upstream address is set; per sender (10), per server (1,000) and per address (40) per UTC day **for non-exit operations only**; **exits are never counted against a person or the server** and have one per-address cap (200); the method is pinned and the body capped; the call-data decoder is in the first cut | A limit in front of exits (anyone can name a victim's address and stop their take-out); an authenticated sponsor (later); a limit only at the operator's own sponsor (the repo would still have none) |
| C28 | Email is declined | Email (it holds addresses) |
| C29 | Push endpoints: https, a known push-service host or an operator-listed one, private addresses refused at send time | Any https address (a way to make the server call its own network) |
| C30 | The season command is `buzz launchpad seasons`, signed with the operator's own key from the environment | A `buzz-admin` command (it works on the database, not by signed record) |
| C31 | Three stub files, created by A1 and owned by the later package, are the only files two packages touch, with one append-only shared file (`app/scripts/check-copy.mjs`) and `scripts/pot-app-loop.sh` handed from A2 to A5; everything else has one owner | Parallel edits of `ProjectPage.tsx` and `HomePage.tsx` |
| C32 | The estimates are about 74 engineer-days against the design's 3 engineer-weeks for step 3a and part of 4.5 for 3b | The design's figures (low) |
| C33 | Migration numbers 0073 (P1) and 0074 (P3) are the next free ones at merge; each engineer checks `ls migrations` first | Fixed numbers |
| C34 | Reserved words for the record's names: `held`, `feed`, `streaks`, `established` | Other names |
| C35 | The team (the founder and whoever the founder lists) can remove posts in its own room and stop a person for up to 30 days, following their linked wallets; a team member cannot remove the founder's post; the operator keeps all powers | No team powers (a room nobody can keep clean); permanent bans by a team (leaving is the exit, but a permanent shut-out of a holder from their own project's room is not a team's to give) |
| C36 | A report goes only to the operator's queue (NIP-56); the team does not see reports | A team-visible report count (a second path and a harassment tool) |
| C37 | Replies, likes, reposts and comments that name a stored room post are room events and must carry its tags (4.1) | Run the rule only for events with the room tag (an untagged reply from a stranger shows in the thread and cannot be removed) |
| C38 | The banner is one shell-level component plus the full sentence in `PotSheet`; the room's moderation sheets show no money and carry none; the line "This can go up or down. It is not a return." stands once under each list or card heading that shows a live number | The banner in every sheet including report and mute (noise); the line under every row (heavy) |
| C39 | The project page puts the money, "Taking out now would give {x} for each Share.", the banner and Back first; people, kept money, updates, tasks and the allowance come after the buttons or in Details | The earlier order (Back at row 11 could not be in the first screen) |
| C40 | No word list for perks; the fixed line under them, the operator's powers and the legal line are the defences | A speed bump of forbidden words (a false comfort another client skips) |
| C41 | The room's "Hidden people" list stays (small, in the room), the You version is dropped | No list (a person who hid someone by mistake cannot undo it: a guard that hides the only way back) |
| C42 | The demo day order is a hash of the season and the project key; cards carry name, line, money and last update only | Entry order (the first entrant keeps top billing); more facts per card |
| C43 | The 30-day and 91-day windows of `held` are counted apart; either may be null | One key for both (a busy project loses both when only the long window is over the cap) |
| C44 | The alert cursor starts at the final block when push is first switched on | Start at 0 (replays all history to every holder) |
| C45 | `/info` carries `smartAccountLinks` so the app can say plainly that phone accounts cannot use rooms and alerts on a server with no chain connection | Show a button that cannot work |

Counsel's list (JOIN-LEAVE-DESIGN section 12) is not changed by this plan; I add three notes for the owner to pass on, **not answers**: whether a room that only
holders may write, with a "perks" text, changes how the Shares are read against the legal line; whether a ranking by money that stayed is a "marketing" of the
Shares; and whether a push message about a project's tasks to a holder is a communication counsel wants worded.

---

## 12. Review of this plan

Two independent reviews read the first version of this plan (commit `ac66c8370`) against the code. Each finding was checked in the tree before the plan was
changed. "A" is the first review (3 blockers, 8 important, 12 optional), "B" the second (2 blockers, 10 important, 6 optional, cuts and gaps).

### 12.1 Changed (and where)

| Finding | What was real, and what the plan now says |
|---|---|
| A-B1 (anyone writes without holding by answering a room post untagged) | **Real.** `use-posts.ts` reads replies, likes and reposts by `#e`; `is_home_post_kind` excludes kind 7, so the team could not remove them. 4.1 and 4.2: an event that names a stored room post is a room event and must carry its tags; R12, R17 (replaced, it asserted the hole), R24; attack 5; C37 |
| A-B2 (vested grant lets leavers write for ever) | **Real** (`vested` is "unlocked so far, claimed or not", RECORD-V2 line 188; `claimable` is line 189). 4.2 step 5 tests `claimable`; R5b |
| A-B3 (the sponsor limit in front of Take out can be turned against anyone) | **Real**: the `sender` is in an unauthenticated body and `aa.ts` retries. 6.7 rewritten: exits are never counted or refused by the per-account or server limit, the decoder is in the first cut, the method is pinned, the body capped, batches refused; K8, K9; C27 |
| A-I1, B-I10 (dust opens a seat) | Floor `ROOM_MIN_SHARES` = 0.001 of a Share, in Shares not dollars (4.2 step 4, 6.5); R1 to R5; C3 |
| A-I2, B-I1 (the `held` bound is not a bound; success is punished) | **Real**: an `ORDER BY account` after an index scan sorts the whole window. 2.2.1 rewritten: the running minimum is computed in Postgres, the `LIMIT` is inside the read of this project's rows from the window's first block, one row per account comes back, the two windows are counted and nulled apart; H4, H9 (a 1,000,000-row table and `EXPLAIN (ANALYZE)`, falsifiable), H10 |
| A-I3, B-B1 (the ranking rests on the wrong input set and is heavy) | **Real** (`use-home.ts` reads the newest 60 kind 37001 records). The server-signed index of the first plan's section 10 is **promoted into P1** (2.8, 3.1, IX1 to IX4, C12): Home reads one record of about 4 KB, built from all launched projects and tied to each coordinate |
| A-I4 (a team mute is trivially evaded) | The mute carries the muted account's linked wallets and the rule refuses any account bound to one (4.2 step 7, 4.4, R25); and the plan now says plainly that the founder alone controls "the team" (`launch_update_authority.rs`: founder plus `team` tags; no acceptance step) |
| A-I5 (the push cursor has no start) | 6.5: it starts at the final block when push is first switched on; old rows are dropped; P7b; C44 |
| A-I6, B-I5 (ownership table incomplete) | 8.1: `mobile/lib/shared/kinds.g.dart`, `buzz-cli` `lib.rs`, `help_tree.rs`, `Cargo.toml`, P3's `schema/schema.sql`, `schema/seeds`, `schema/triggers`, `migration.rs` lists and the reconcile script, A3's `Composer.tsx`, `PostCard.tsx`, `BackSheet.tsx`, `mutes.ts` (new), A2's line in `pot-app-loop.sh`, an append-only `check-copy.mjs` |
| A-I7, B-I6 (the server work runs in parallel, against the brief) | 8.2: P1, then P2, then P3, with a recalculated calendar (44 days, 74 engineer-days) |
| A-I8 (seasons have no removal and no cost) | `season-remove` (operator), a bar of 3 counted accounts, an advisory lock per season, paging (5.2; M4, M5, M6, M9) |
| A-O1 | The link ends after 365 days: the app prompts a renewal 30 days before; the rule reads the binding's chain (4.2 step 3; R22; A3-link) |
| A-O2, A-O3 | Corrected: `crates/buzz-auth/src/nip98.rs` verifies (6.3); only `hmac` was a workspace dependency, the three others are added (section 1, 8.1) |
| A-O4 | The plan's excluded set matched `numbers.rs` (it passes the Launcher), so the claim was half right; but a second copy of the list is a risk, so P1 adds `Ledger::excluded` and both call it (2.2) |
| A-O5 | The volume sentence is reworded (2.4, attack 3) |
| A-O7 | `scripts/check-cross-language.mjs` (A5; X3) ties the character limit, the alert kinds and the refusal words |
| A-O8, A-O9, A-O10, A-O12 | SSRF connects to the checked address (6.3); 37021's doubt is recorded (5.1, C10); the operator's page says push timing is visible (6.1); `/info` carries `smartAccountLinks` (6.1, C45) |
| A-O11 | Exits are exempt from the per-address limit; a shared carrier address can still hit it for other operations (6.7, said) |
| B-B2 (the one-screen test cannot pass) | **Real.** 7.1 reordered: name, chips, money with its line, "Taking out now would give {x} for each Share.", the play-money line, the banner, then Back and Share; the rest below or in Details; C39 |
| B-I2 (the banner is not on every page and sheet) | **Real** (`pot-words.ts` has only `CAN_TAKE_OUT`). New 7.0: `TAKE_OUT_BANNER`, `MoneyBanner` in the shell, the full sentence in `PotSheet`, the line once under every list or card heading with a live number, a test that walks every route and sheet; A1 owns these |
| B-I3 (the wallet-link wall) | 4.7: the link is the last step of Back (automatic for a passkey account, one signature for a wallet); the button is recovery only; the draft is kept and one automatic retry after 30 s; a plain line when the server cannot check phone links |
| B-I4 (perks have no home) | **Real** (`start-record.ts` only creates). 4.5: `room/perks-record.ts` copies every tag and a test fails if one is lost; `room/PerksSheet.tsx` |
| B-I7 (streak windows flap) | 2.5: windows aligned to the launch, a fixed grid; stricter than the contract's rule on purpose, and said; S1 to S4; C14 |
| B-I8 (assistive semantics and recovery) | 7.6: actions named with the author, a visible Close on every sheet, the draft kept on every refusal, the mute sentence names the date and what stays open |
| B-I9 (is it fun) | The room tab's "New" dot (device-local), the team's newest notice pinned, the feed leads with what lasted and keeps hours behind one press (7.5, 7.6) |
| B-O1 | 2.8 says plainly that it is money held, valued at a take-out, and that the index carries no price field; the first plan's wording "never the price of a Share" stays true of the key and is no longer misleading |
| B-O2 | Demo day order is a hash of the season and the project key (5.3, C42) |
| B-O3, B-O4, B-O5 | Recorded (5.1, C10); copy fixed ("open to backers first", "Not ready yet. Try again in a minute.", the wind-down item is gone, "Money that stayed"); the note that other clients show room posts is in 4.1 |
| B cuts taken | `held.badge.money` and `held.badge.accounts`; the `rate_proposed` and `wound_down` feed items; the perks word list; demo-day card facts reduced to name, line, money and last update |

### 12.2 Declined, and why

| Finding | Why not |
|---|---|
| A-B2's second half, "and `state != closed`" | A closed grant that still has something to claim is Shares the member owns and may claim: they are a holder until they claim. Once claimed, `claimable` is zero and the grace runs. `claimable != 0` alone ends the access with the Shares |
| A-B3's other fix, an authenticated sponsor (NIP-98 plus a verified link for the `sender`) | It would need the app's account client to sign each sponsor call, a change to code no package here owns. The exemption of exits closes the harm that matters (leaving); the rest is a nuisance that is said and listed in section 10 |
| A-I2's "scan only the window" is done; its remedy for dust-nulling | No remedy is built: a person with Shares can make about 250,000 one-wei moves in 91 days and null a project's badge. It costs a ranking row or a badge and nothing else. Said in 2.2.1 and attack 2 |
| A-I1 as a sybil defence | The floor stops one-wei seats only; a person who pays for more is held by the per-wallet cap, rates, the wallet-following mute and the operator. Said in 4.2 |
| A-O6 (the link preview carries the founder's pitch unfiltered) | The server's preview is the founder's own words with no amount and no count; filtering it needs a word list in Rust that must match the app's. Said in 7.2 and for the report |
| B-O1's test "a pot jump alone does not raise it" | By definition a pot jump does raise `leaveValue` and so the money. What is tested instead is that the key reads no price field and the text says what it is |
| B-I10's per-project hourly cap on room posts | One attacker could fill the cap and silence the room for everyone. The per-account, per-wallet and per-wallet-account limits and the mute apply instead |
| B-I9's "This week" line on You | More reads on You for little: the news section, the "New" dot and the pinned notice cover the weekly reason to come back |
| B cut: the Rust call-data decoder | Needed now: it is how an exit is told from other operations (6.7). It also gives the allow-list for free |
| B cut: the Hidden people list | Without it a person who hid someone by mistake cannot undo it (a guard that hides the only way back). The You version is dropped; the room's own small list stays (C41) |
| B-I2's banner on the room's moderation sheets | They show no money; a banner there is noise. A recorded choice (C38) |

### 12.3 Still open for the owner

The two things the plan could not settle by reading: whether kind 37021 is free (5.1), and whether counsel is content with a holders-only room with perks text and a
ranking by money that stayed (section 11, counsel's list). Neither blocks the first package.
