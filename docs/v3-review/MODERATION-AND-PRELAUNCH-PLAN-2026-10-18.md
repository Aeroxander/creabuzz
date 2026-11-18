# Moderation, social launch and launchpad pre-audit plan — 18 October 2026

> **History (noted 2026-10-23).** Version 1, replaced by [version 2](MODERATION-AND-PRELAUNCH-PLAN-V2-2026-10-18.md), which says where each Phase A item stands as of 2026-10-23.

Status: **proposal, for the other agent to check before anything is built.** No code, test or contract was changed to write
it. Written against `HEAD 494b84180` plus the uncommitted working tree as read on 18 October (the other agent's D60 work,
the user's board/pitch/template edits). Part 1 lists what was verified in the source and where; part 2 lists what was
*not* verified and must be checked first; the plan itself follows.

The user's constraints for this plan: social features launch in days; the launchpad stays testnet-only for about a month of
refinement and audit; moderation should end up democratic (DAO-voted moderators) without the usual pitfalls; reuse Nostr
standards instead of inventing; no changes without the user's say-so; a "Testnet" chip beside the logo is enough (no
per-item labels).

## 0. What the checker should do

1. Confirm or refute every item in part 1 (file and line are given) and settle every item in part 2 with evidence.
2. Challenge the design in parts 3 to 6: look for a hole in the threat model, a smaller way to the same end, or a
   conflict with an existing contract or relay rule.
3. Report findings in the review format already used in `docs/v3-review/` (P1 / P2, the defect, how it fails, the fix).
   Mark everything else optional.
4. Do not start building. Where this plan touches files with uncommitted work (board UI, `AppNav.tsx`, the shell), say so,
   because those need to be committed or coordinated first.

## 1. Verified in the source

| # | Fact | Where |
|---|---|---|
| F1 | Community moderation has two roles, `owner` and `admin` (from `relay_members`), who hold every capability community-wide: delete a message, kick, ban, unban, timeout, untimeout, resolve a report, read the queue. A channel owner or admin holds only delete-message and kick, inside their own channel. There is no moderator tier ("adding one later is a policy change, not a rewrite"). An admin cannot ban or timeout the owner or another admin. | `crates/buzz-relay/src/handlers/moderation_authz.rs` lines 1–45 and the `authorize_moderation_action` body |
| F2 | A ban is enforced at authentication: the key is rejected at the door and disconnected everywhere in the community. Ban lists are read over HTTP with NIP-98 auth. | `VISION_MODERATION.md` ("Enforcement lives at the identity seam"); `web/src/features/communities/use-bans.ts`; routes in `crates/buzz-relay/src/router.rs` (`/moderation/restricted`) |
| F3 | Joining an open channel is one kind-9021 write, and `handle_join_request` adds the member without checking whether they were removed before. A kicked person can rejoin an open room. | `crates/buzz-relay/src/handlers/side_effects.rs` `handle_join_request` (~line 2278) |
| F4 | A launch's team room is private, its supporters room is open (self-join with 9021), its backers room is private and admitted by the founder (kind 9000). The founder creates the rooms. | `web/src/features/launchpad/use-launch-chat.ts` header comment |
| F5 | A board is a channel: a post is kind 45001 and a comment kind 45003, both with an `h` tag for the board. | `web/src/features/board/lib/board-events.ts` lines 1–24, 38–67 |
| F6 | The board UI lets only the author delete their own post or reply, and offers no Report. `ReportDialog` is used only in `social/ui/PostCard.tsx`, `feed/ui/NoteCard.tsx` and `channels/ui/ChannelTimeline.tsx`. DMs and profile pages have no report or block. | `web/src/features/board/ui/PostThread.tsx` header comment; grep of `ReportDialog` |
| F7 | A mute list (kind 10000) exists and hides people in the social feed only. | `web/src/features/social/lib/lists.ts`, `social/ui/PostList.tsx` |
| F8 | Reports are NIP-56 (kind 1984) but private structural state, never public events; the reporter is visible to owner/admin, never to the reported author. No automod. Platform-safety escalation is "a hook today, not a pipeline". | `VISION_MODERATION.md` ("Honest Edges"); `web/src/features/moderation/lib/report.ts` |
| F9 | The relay rate-limits websocket events and messages per connection and audits the rejections. | `crates/buzz-relay/src/rejection.rs` lines 66–107 |
| F10 | Majeur's `Badges` are soulbound ERC-721 for the **top 256 shareholders, updated automatically as balances change**. It is a wealth rank, not a trust credential. | `contracts/lib/majeur/README.md` lines 59, 79 |
| F11 | TrustGraph here is a score system proven from community activity and published as a Merkle root in kind 37006 (global, parameterized replaceable); `TrustGatedHook` verifies proofs for bids. The design doc lists score publishing (NIP-85) and client-side verification as missing. | `crates/buzz-core/src/kind.rs:873`; `contracts/src/hooks/TrustGatedHook.sol`; `docs/next-gen-launchpad-plan.md` §1, §3 (older than this plan) |
| F12 | The relay already binds a key to a wallet: `evm_identities` and the SIWE register route; a kind-37017 binding record is signed by the key. | `crates/buzz-db/src/evm_identities.rs`; `crates/buzz-relay/src/api/evm_auth.rs` header |
| F13 | `docs/audit-readiness.md` is dated 30 Sep, counts 191 tests, and does not mention `MilestoneChallenge`, `AllocationVoting` or `DaoLaunchKit` (grep count 0). | `docs/audit-readiness.md` |
| F14 | `AppNav.tsx` has no testnet indicator. | `web/src/app/AppNav.tsx` |
| F15 | No minimum proof-of-work setting was found in the relay config or `.env.example`. | `crates/buzz-relay/src/config.rs`, `.env.example` (a negative result: please re-check) |
| F16 | The other agent's working tree now: linked project work is read only from rows signed by the team (`teamTaskRows`), indexed by an `["a", project]` tag and bounded by team authors, so a stranger can no longer put a task, link or assignee onto a project page; role, budget and agent reads are scoped by relay and account and retry without reloading the page; the launch form shows the earliest-release schedule (days 7, 51, 102, bond day 132 for 20/30/50); the claim-expiry queue wording is fixed. | `web/src/features/fleet/lib/project-work.ts`, `use-project-work.ts`, `fleet/lib/task-delivery.ts`, `launchpad/ui/LaunchReviewFields.tsx`, `launchpad/lib/dao-overview.ts` |

## 2. Not verified: settle these first

- **V1.** Does a channel owner/admin's kind-9005 delete (and the owner/admin moderation delete) apply to forum post and
  comment kinds 45001/45003, or only to chat messages? (`handle_delete_event_side_effect`, `side_effects.rs` ~1952.)
- **V2.** Does a kind-9001 removal write `channel_members.removed_at` in a way F3 ignores? Confirm with a test that a removed
  member can rejoin an open channel, and that a removed member's old messages stay.
- **V3.** Can a banned key still read public launch records and evidence over HTTP without authenticating? A ban that blocks
  reading would cut a holder off from the evidence they need to object to a milestone.
- **V4.** Community topology at launch: one community per project (the founder is the community owner) or one shared
  community (founders are only room owners)? The answer decides who holds F1's powers in project spaces.
- **V5.** Do the standards named below say what is claimed? Cited from memory, not re-read: NIP-13 (proof of work, minimum
  difficulty advertised in NIP-11), NIP-29 (groups: roles, kinds 9000/9001/9005, `closed`/`restricted`), NIP-32 (labels),
  NIP-43 (relay membership), NIP-51 (mute lists), NIP-56 (reports), NIP-72 (moderated communities: approval events),
  NIP-86 (relay management API), NIP-98 (HTTP auth).
- **V6.** Status of TrustGraph integration today (score publishing, client verification, who runs the operator).
- **V7.** The other agent's project pages ignore status rows signed by anyone outside the team, by design
  (`project-work.test.mjs`). If an assigned agent's key is not on the launch's team list, its "needs review" and "done" rows
  never show on the project page. Is that intended, and how should an agent's own work appear?
- **V8.** Whether the relay can enforce "post only if followed by N trusted members" or "link cooldown for new keys" without
  new storage (follow lists are replaceable events).

## 3. Principles

1. **Moderation is not a right.** Chat and board moderation never touches voting, objecting to a milestone, exiting with a
   share of the treasury, or reading a project's public record. Anything a ban could block must stay reachable by another
   route.
2. **Two scopes.** Room-scoped powers (chat rooms, boards) for moderators and founders; community-wide ban stays with owner
   and admin for spam and abuse of the whole community.
3. **Fast hands, slow rules.** Moderators act at once within narrow powers; who the moderators are and what the rules say
   changes slowly and publicly.
4. **Everything is logged, reasons are a menu, rules are cited.** Reporter identity stays private; the log shows category,
   rule number, action and time.
5. **Prefer labels and mutes to bans** where they serve; a ban is for spam and abuse, never for criticism of the project.
6. **No automod in v1** and no model in the decision path. A classifier, if ever added, only flags (see the GLiClass
   discussion: advisory, evaluated on our own and adversarial data first).
7. **The operator's platform-safety layer is outside any vote.**
8. **No chain read in the enforcement path.** Roles that come from the chain are copied into the relay's own tables by a
   one-way, fail-static sync.

## 4. Phase A: before the social launch (days)

Each item lists what, why, acceptance and what it touches.

**A1. Durable room ban (relay).** A per-channel ban state: the member row records `banned`, the open-room join path (F3)
refuses it, writes to that channel are refused, ban and unban are signed commands with audit rows and a notice to the
person. Who may: channel owner/admin and (A3) moderators; community owner/admin as today.
Acceptance: a banned key cannot rejoin an open room (test fails on current code); the ban does not affect another room,
login, the feed, DMs, reading launch records, or any on-chain action; unban restores; a ban of an owner or admin by a
lower role is refused; the audit row names who, whom, why category, when.
Touches: `side_effects.rs`, `channel_authz.rs`, `moderation_commands.rs`, `buzz-db` channel members, web room UI.

**A2. Report and removal on boards, DMs and profiles (web).** Add `ReportDialog` to board posts and comments, DMs and
profiles; add delete and room-ban for founders and moderators on boards (depends on V1); add mute and block to profiles.
Acceptance: each surface offers Report; a founder can remove an abusive board post and the room sees a tombstone; reports
reach the existing queue unchanged.
Touches: `web/src/features/board/ui/*` (uncommitted user work: coordinate), `dms`, `feed/ui/ProfilePage.tsx`.

**A3. Moderator role (NIP-29 custom role).** Owner/admin appoint moderators per room or board, with grant and revoke
screens. A moderator can delete, kick, timeout (cap 7 days) and room-ban; cannot community-ban, cannot act on an
owner, admin or fellow moderator, cannot appoint. Authority in the audit row: `ChannelRole`.
Acceptance: `moderation_authz` tests for every capability and every guard rail; revoke takes effect at once.

**A4. Moderation log.** A member-readable log of actions per room: action, category, cited rule, time, acting role;
no reporter. Tombstones already exist for removed messages (F8).
Acceptance: a ban, a delete and a timeout appear within a minute; the reporter and report notes never appear.

**A5. Reasons are a menu in project spaces.** Ban, timeout and delete in project rooms require a category: spam or scam,
harassment or threats, impersonation, illegal content, doxxing or personal data, malware or phishing, off-topic rule
(cites a rule number). "Disagreement" is not a category.
Acceptance: the command is refused without a category; the log shows it.

**A6. Emergency override (v1 version).** In v1 the community owner/admin (the founder where V4 says so) may act at once on
the categories above; each such action is flagged `emergency`, expires after 72 hours unless a second owner/admin or a
moderator confirms it, and shows in the log. The honest limit: the relay cannot stop an owner from using the unrestricted
route; the log and the menu make misuse visible, they do not prevent it.

**A7. Platform-safety escalation process (operational, not code).** A named recipient for escalations, a takedown runbook,
an abuse contact and terms of use, before public user content. Not legal advice; the user should take it to counsel.

**A8. Spam and abuse.** Keep relay rate limits (F9). Add a link cooldown for brand-new keys (config, off by default in
tests). Public-Nostr copy stays opt-in; make the "cannot be recalled" warning explicit at the checkbox. Do **not** add
proof of work now (cost falls on phones, not on bots with GPUs); if wanted later, only as a switch raised for new keys
during a flood (NIP-13 difficulty advertised in NIP-11). Depends on V8.

**A9. Cold start and identity.** Seed a welcome post, starter boards and a few real pilot projects; hide zero counts; a
"Start here" board; follow suggestions on an empty Following tab; a Team badge on posts by a launch's team (from the signed
launch record); role badges in rooms (Team, Backer, Supporter, Reviewer) from the record and bids.

**A10. Testnet indicator.** A small "Testnet" chip beside the logo, shown when the configured chain is not mainnet and gone
at mainnet. Touches `web/src/app/AppNav.tsx`, which has the other agent's uncommitted edits: do it after they are
committed.

## 5. Phase B: weeks after the social launch

- **B1. Approve-first for open boards and rooms** (the NIP-72 pattern): posts from keys younger than N days wait for a
  moderator's approval; per board setting; approvals are events.
- **B2. Agents in the launch rooms.** Team room: a founder's assistant that drafts updates and evidence from the work log;
  a human approves, never posts as the team on its own. Supporters room: a read-only explainer that answers from the
  project's record with citations, no price talk, no promises. Backers room: a weekly digest. The supporters room is open to
  anyone, so its agent reads untrusted text: no side-effect tools, no credentials, per-room budget shown.
- **B3. Founder chat quality:** an announcements room with founder-only posting (NIP-29 `restricted`), pinned rules, slow
  mode in the open room, quick polls before formal votes, a catch-up summary, a clear note that chat is not a decision.
- **B4. Feed:** weekly recap; follow suggestions; a "why am I seeing this" line is optional.
- **B5. Paid moderation** through the existing work-budget claims (flat stipend, not per action).

## 6. Phase C: with the launchpad and the audit (about a month)

**C1. Audit package.** Rewrite `docs/audit-readiness.md` (F13): the full contract surface including `MilestoneChallenge`,
`AllocationVoting`, `DaoLaunchKit` and the two lock factories, the test counts, the mutation-checked guards, the accepted
trade-offs (silence unlocks; a majority holder decides votes; the last milestone is backed by a bond only; the payment token's
issuer controls; D56 to D58), and the residual risks. Set a freeze date; each review cycle so far found a real defect.

**C2. Stateful invariant test for `MilestoneChallenge`.** Random sequences of submit, object, vote, resolve and time
jumps. Properties: locked plus unlocked plus burned Shares equal the allocation; `lockedOf` never increases; the lock's
token balance equals the bonds and deposits still owed; a milestone cannot unlock while an earlier objection is open or its
month is running; a burned tranche is never unlocked.

**C3. Decisions that move the audit's scope:** the trading venue (Uniswap v4 or not); whether the moderator contract
(below) is in this audit or its own; the legal posture for the token sale (longest lead time); push or email alerts to
holders when a milestone is published (the protection is attention).

**C4. DAO-voted moderators (design; build after the audit's scope is fixed).** A separate roster contract, not Majeur's
badge (F10).
- *Badge:* soulbound, with a term (default 90 days) and states `active`, `suspended until`, `revoked`.
- *Appointment:* optimistic. Anyone eligible nominates with a statement; the nomination stands unless holders object in a
  window; eligibility and weight use the milestone-objection rule: non-team Shares owned just before the snapshot
  (`getPastCapacity`), capped by current holdings, plus a minimum holding age.
- *Limits:* at least three moderators, a maximum, staggered terms, a cap on how many communities one person moderates, no
  moderator acts on content about themselves, the team can never hold a majority of seats.
- *Rogue moderator:* any moderator may freeze a colleague for 24 hours (a stolen key); a majority of the **other**
  moderators (at least two) may suspend, effective at once and expiring after seven days unless holders confirm; permanent
  removal is a holder recall, optimistic with a deposit. Moderators may remove at most one colleague per period.
- *Rules:* a versioned rules document pinned by hash, as milestone words are; actions cite a rule number; changing the
  rules is a holder vote.
- *Reporter privacy:* moderators who are pseudonymous holders see the report and its category, not who filed it; severe
  categories go straight to the operator.
- *Relay side:* a worker watches one event (`RosterChanged`) and writes the roster into the relay's own member table using
  `evm_identities` (F12); chain unreadable means current roles stay; no chain read in the enforcement path.
- *Non-token communities:* owner-appointed moderators; TrustGraph or the follow graph only suggests candidates (a score
  measures social standing, can be farmed, and depends on the operator who publishes the root, F11).
- *Authority limits:* a moderator's ban is room-scoped (principle 1). Owner/admin keep the community-wide ban and the
  emergency override of A6; if the DAO should bound the owner's powers in project spaces, bind the owner key to the DAO
  through `OrgBinding` and restrict owner moderation there to the A5 menu with the log public. State plainly that the
  relay still trusts its owner.

## 7. Open decisions for the user (not for the checker)

1. V4: one community per project, or one shared community?
2. May a moderator room-ban (A3), or only delete, kick and timeout?
3. Does the founder keep the emergency override (A6), or only the operator?
4. Is the moderator contract part of this audit (C3)?
5. Who receives platform-safety escalations (A7)?

## 8. Sequencing and conflicts

- Day 1 to 3: V1 to V4 answers; A1, A3, A4, A5; A7 started. Day 3 to 5: A2 (after the user's board work is committed), A8,
  A9, A10 (after the other agent's commits).
- The working tree mixes the user's board/pitch/template work with the other agent's D60 work across about 44 files, all
  uncommitted. Before building, agree how to slice it into commits (navigation, progress feed, task links, agents tab,
  moderation) so that moderation commits stay reviewable.
- Nothing here changes a contract before the audit scope is fixed, except by decision C3.

## 9. Questions for the checker, in order

1. Settle V1, V2, V3, V5, V6, V7, V8 with evidence.
2. Is A1 the smallest change that makes a founder's ban stick in an open room? Is there a narrower relay change?
3. Does A3's capability grid leave a path for a moderator to reach a person's rights (principle 1)?
4. Does A6 give the founder more power than the user intends, given the relay trusts its owner?
5. In C4, can the suspension and freeze paths be abused to purge a dissenting moderator? What is the cheapest extra brake?
6. Which items in this plan are wrong about the code, and which are right but should wait?
