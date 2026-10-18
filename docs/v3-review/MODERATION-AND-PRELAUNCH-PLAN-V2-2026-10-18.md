# Moderation and pre-launch plan, version 2 — 18 October 2026

Status: **revision for the checker; no code, test or contract changed.** It answers the checker's review of
`MODERATION-AND-PRELAUNCH-PLAN-2026-10-18.md` (version 1). Version 1 stays as written so the F1–F16 and V1–V8 numbering still
means something; where this document and version 1 disagree, this one wins.

## 1. How the review was handled

I re-read the cited source for each finding instead of taking the review's word for it, and fetched the two NIP texts.
Re-read and confirmed: the HTTP query gate and community admission (`api/bridge.rs` `query_events`, `api/mod.rs`
`enforce_relay_membership` → `deny_banned`); the moderation queue and `report_json` (reporter and note returned to any
owner/admin, no exclusion of the accused); `decide_put_user` and the membership upsert (open channel: "anyone may join",
self-join gets Member); the global-only header of `moderation_commands.rs`; `use-board.ts` and `board-model.ts`; `nip11.rs`
(`min_pow_difficulty: None`); `rejection.rs` (quotas keyed by tenant and principal); `ProfilePage.tsx` (Mute exists);
`use-self-serve.ts` and `api/self_serve.rs`; NIP-72 and NIP-29 on GitHub.
**Not re-run:** the reviewer's live-relay reproductions (so "reproduced live" below means "the source agrees and the
reviewer ran it"), the invariant-test and bid-badge findings (source reading only).

### Where version 1 was wrong (accepted)

| Item | Version 1 said | Correct |
|---|---|---|
| F6 / F7 | Profiles have no report or block; mutes only in the social feed | Profile already has Mute; mutes filter the legacy social list, not Home, progress, boards, DMs or notifications |
| F8 | A report is "never visible to the reported author" | False for a reported owner/admin: the queue shows them the reporter and the note |
| F9 | Rate limits are per connection | Per tenant and principal; rejection audit rows may be shed when their queue is full |
| F11 | Score publishing and client verification are missing | Root composition, publication, gate rotation and client proof verification exist; only NIP-85 publication is absent. A root proves inclusion in a publisher's commitment, not correct scoring |
| V4 | Operator-provisioned communities | Self-serve community creation exists; both topologies are possible |
| B1 | NIP-72 approve-first is the pattern | NIP-72 is marked unrecommended ("try NIP-29 instead") and does not make relays hold posts back |
| B3 | NIP-29 `restricted` gives founder-only announcements | `restricted` means only members may write; NIP-29 defines no ban and no role permissions (relay policy) |
| A6 | A blanket 72-hour override that expires unless confirmed | Incoherent for deletions (expiry cannot restore doxxing) and the confirmer is owner-appointed; dropped |
| C4 | Optimistic nominations that stand unless holders object | Silence-accepts is wrong for privileged seats: inactive holders let a determined holder accumulate seats |
| C4 | Fail-static role sync | Retains an expired or revoked moderator's authority through an outage or a missed event |
| C4 | One colleague removed per period; freeze 24 h; suspend 7 days | No non-renewable case limit; repeated freezes or suspensions silence a dissenter |
| C2 | Lock token balance equals bonds and deposits owed | A donation breaks equality; assert `balance >= liabilities` and use ghost counters for historical locked, unlocked and burned |
| A9 | Backer badge from bids | A bid mirror is a signed claim, not proof of an on-chain bid |
| §8 | Day 1 to 3 for A1, A3, A4, A5 | Schema, authorization, events, CLI and client work; not supported |

### Where I qualify the review

1. **P1 evidence access** is right and stays P1 for the launchpad, but its reach depends on topology. It bites the
   community-wide ban. A room-scoped restriction does not block `/query` (launch records are not room content), and in a
   shared community the founder is only a room owner and holds no community-wide ban at all. So the topology decision
   (§7, question 1) removes most of the exposure for the social pilot, and the independent reader is still required before
   the launchpad is public.
2. **"Use existing DAO machinery to appoint moderators"** still needs a component that turns an executed decision into relay
   authority (the reviewer says so). That adapter is small, but it is where expiry, revocation and reconciliation live (C5).
3. The A6 finding is correct for deletions; for a time-boxed ban or timeout, expiry is coherent. The conclusion (drop the
   blanket mechanism) stands.

## 2. Principles, revised

1. Moderation of conversation never gates a holder's financial rights: evidence, objecting, voting, exit, appeals.
2. Kick and leave are not restrictions. A restriction is an explicit, scoped, enforced state.
3. Room scope and community scope are different authorities; the global commands 9040–9044 are global-only by contract and
   are never reinterpreted as room commands.
4. A complaint about a privileged person is routed away from that person; the accused never reads who filed it.
5. Authority that comes from outside the relay (a DAO, a score) expires locally and can be revoked locally.
6. Logs show category, rule, role and time; they are accountability, not proof of motive.
7. The relay owner and operator remain trusted; say so in the documents.
8. No automod, no model in the decision path.

## 3. Phase A: before public social content

Honest effort: A0, A1, A3, A4 and A6/A7 are days of work; A2 is a relay schema, authorization, event, CLI and client
change (plan for one to two weeks). If the social launch cannot wait for A2, launch with ordinary room-owner delete and kick,
the operator as the community-wide backstop, and a plain statement that kicks in open rooms are not durable.

**A0. Operator, abuse and appeal process.** A named recipient for platform-safety escalations, a takedown runbook, an abuse
contact, terms of use, and an appeal route that does not depend on the person being moderated. Operational, not code; not
legal advice. Gates any public user content.

**A1. Report privacy (fixes the P1).** On the server: a report whose target is the actor (or an owner or admin when the
actor is not the operator) is excluded from that actor's queue and visible only to the operator; notes and reporter fields
are never returned to the accused; any future room-moderator queue is scoped to that room and redacted (reporter
removed, notes shown only when the room's own members authored them). Acceptance: a reported owner cannot see the reporter
or the note; a moderator sees nothing from other rooms; the reporter still gets the outcome message. Limit stated in the
docs: a host with database access can read everything.

**A2. Durable room restriction.** A new per-channel restriction state, separate from `removed_at`. It is checked at every
way back in and every write: the open-join path (9021), self-add and privileged add (9000), invitation paths, and event
writes to the channel. Kick and voluntary leave keep today's behavior (a person can come back to an open room). Defined
unban, transaction and race handling with the membership lock, cache invalidation, an audit row and a notice. A new signed
command (not 9040–9044), also in `buzz-cli`, with a room-owner/admin capability only at first. Acceptance (each must fail on
current code): a restricted key cannot return through 9021, through its own 9000, or through a privileged add by a
non-elevated member; it cannot write; a person who left on their own can return; other rooms, login, the feed, DMs and
reading records are unaffected; unban restores; an owner or admin cannot be restricted by a lower role.

**A3. Board reporting and removal that readers see.** `ReportDialog` on board posts and comments. Founder or owner delete (the
server already allows 9005 on 45001/45003). The board client must consume authorized moderation removals and the relay's
40099 tombstones and honor them only with scope and provenance checks, not any event that looks like a 9005. Acceptance:
two open readers both see a post and a comment disappear and a tombstone appear without a refresh; an arbitrary 9005-shaped
event from a non-moderator changes nothing.
Touches `board/ui/*` and `board/use-board.ts`, `board/lib/board-model.ts` (uncommitted user work: coordinate first).

**A4. Personal mute and block.** Define what Block does: DMs, mentions, notifications, boards, the progress feed; whether the
list is public (NIP-51 allows private entries); that a financial deadline is never hidden by a personal mute. Extend the
existing Profile mute accordingly.

**A5. Sanitized room action log.** Action, safe category or rule number, acting role, time. No reporter, no report notes, no
free text that could carry doxxing.

**A6. Testnet chip.** One chip beside the logo, driven by the configured chain and deployment metadata (mainnet includes
Base, not just chain 1). Touches `AppNav.tsx` (uncommitted work of the other agent: after it is committed).

**A7. Small additions.** A welcome and Start-here post, starter boards, follow suggestions on an empty Following tab, the
public-Nostr "cannot be recalled" warning, honest labels: Team from the current launch record; **Backer only when
participation is confirmed on chain with a valid key binding, otherwise "recorded bid"**; Reviewer only from a real
appointment source. No fabricated activity counts.

**Not in Phase A:** a moderator role, any emergency override, link or follow gates, approve-first, proof of work.

## 4. Phase B: after a pilot, once spam volume is measured

- **Room moderators** (if the pilot shows they are needed): a scoped Moderator role that never reuses elevated or admin
  status, starting with delete and a temporary write restriction, a redacted room queue, then room restriction. A new
  role touches core role enums, persistence, group metadata and clients, not one policy function.
- **Announcements:** a role-based write policy in our relay. NIP-29 `restricted` is not it.
- **Approve-first:** only with a written design of pending storage, who can read pending content, who approves, and every
  publication path. Not NIP-72.
- **Link and follow gates:** only if spam appears; define a URL and media policy across HTTP and websocket writes and exempt
  appeals and financial-rights paths; neither gate defeats pre-aged accounts.
- **Agents in launch rooms:** tool-free public explainers with enforced budgets and clear human/agent attribution. Agent
  status on project pages: show agent-reported progress separately, attributed to a team-signed assignment and with a
  distinct approval state; do not add agents to the team list for visibility.
- **Paid moderation:** flat stipends through existing claims, never per removal.
- **Proof of work:** not now; if ever, a switch for new keys during a flood.

## 5. Phase C: launchpad, testnet month

**C1. Ban-independent public record (the P1).** The evidence text a milestone commits to must stay readable by a holder
whatever happens to their relay account. Proposal for the checker to challenge: pin each evidence version in a
content-addressed public store keyed by the hash already committed on chain, mirrored outside community membership, and have
the app read from there when the relay refuses; keep objection, vote and exit wallet-only. Alternative: an allowance for
anonymous reads of the public launch kinds. Test: a community-banned key retrieves the exact evidence and can still object.
Include an appeal path for abuse bans.

**C2. Audit package.** Rewrite `docs/audit-readiness.md` (it is dated 30 Sep, counts 191 tests and omits the newer contracts)
with the full surface, current test counts, mutation-checked guards, accepted trade-offs (silence unlocks; a majority holder
decides; the last milestone is backed by a bond only; the payment token's issuer controls) and residual risks. Freeze the
economic contracts before adding another governance contract. A month is a planning target, not an acceptance criterion.

**C3. Stateful invariant test for `MilestoneChallenge`** (the `AllocationVoting` one already exists). Properties:
`balance >= outstanding bonds and deposits` under stated supported-token assumptions (surplus modelled separately);
ghost counters for Shares allocated, unlocked and burned (a recipient's current balance is not what was unlocked); a
tranche cannot unlock while an earlier objection is open or its month runs; a burned tranche never unlocks; include
forfeitures and bond claims in the handler.

**C4. Decisions that move the scope:** trading venue; legal posture for the token sale; reliable deadline notifications for
holders (attention is the protection).

**C5. DAO-appointed moderators (design only until C2 is settled).**
- Appoint and revoke a small, term-limited roster with the DAO's existing proposal and vote machinery; **explicit approval,
  no silence-accepts, fixed seat limits**. Snapshot and holding age slow some attacks; they do not make a wallet a person.
- Expiry enforced locally from the roster's own terms; a freshness policy; key and binding revocations processed
  independently of the roster; full-roster reconciliation from durable checkpoints with reorg handling; an operator
  emergency revoke. A wallet's linked Nostr keys are not all moderators by default.
- Peer suspension and optimistic recall are deferred. If ever added: one active incident per target, fixed non-extendable
  expiry, a cooldown before reapplication, a denominator that ignores the disputed suspension, and independent appeal.
- A soulbound badge is optional display. TrustGraph may suggest candidates; it does not grant authority.
- Caps on seats per person and "the team never holds a majority" are operational rules, not on-chain guarantees, because
  keys and wallets are not people; say so.
- Moderator bans stay room-scoped (principle 3). Complaints about a moderator go to the operator.

## 6. Existing work conflicts

`AppNav.tsx`, `CommunityShell.tsx`, board `BoardView.tsx` and `PostThread.tsx`, launch pages, task and agent state, vision and
review documents already hold uncommitted work, with new board comment components and DAO OS files untracked; the CCA
submodule also shows modified. Agree the baseline and the commit boundaries before any moderation change, and keep the
submodule out of every moderation commit.

## 7. Decisions for the user

**Decided by the user on 18 October 2026: items 1 to 4 accepted as recommended** (one shared community with project-scoped
rooms and operator platform bans; room moderators after the pilot; no founder emergency override in v1; no new moderator
contract for now). **Item 5 is still open** and gates public user content (A0). Nothing has been built.

1. **Topology.** My recommendation, matching the reviewer's: one shared community with project-scoped rooms and operator
   platform bans for the pilot. Founders then hold room powers only and cannot community-ban a holder. Separate
   per-project communities stay possible, with the C1 reader as the safeguard.
2. **Room moderators now or after the pilot?** After.
3. **A founder emergency override?** None in v1; ordinary room powers plus the operator.
4. **A moderator contract?** No new contract for now; use DAO proposals and a small revocable adapter (C5).
5. **Who receives platform-safety escalations, and what is the appeal route?** (A0.)

## 8. Questions for the checker

1. Is A2's restriction state the smallest design that closes both rejoin paths and every write seam? Does a privileged add
   by a non-elevated member also need to be refused, and where is the single shared decision?
2. Does A1's exclusion rule leave any path by which the accused learns the reporter (notes, notices, audit rows, the outcome
   message)?
3. For C1, which is smaller and safer: a content-addressed public store keyed by the committed hash, or a public-read
   allowance for launch kinds? What does a ban-independent read mean for the NIP-98 gate and tenant binding?
4. Does any item here still depend on something the repository cannot show (deployed operator, enabled self-serve,
   TrustGraph's publisher)? Mark each.
5. Which accepted corrections in §1 are still wrong or incomplete?

## 9. Addendum: admission before restriction (18 October 2026, later)

Decided with the user: **the user is the operator for the pilot**; a platform DAO may take the role later. A key-based
restriction only stops the same key, so entry control matters more than a sticky ban, and the pilot does not need A2.

**Corrections to the first draft of this addendum (the checker's, verified in source):**
- Invite-only community entry does not stop a member who was kicked from an open room rejoining it (9021).
- Private rooms are not founder-admitted by rule: any active member may add an ordinary member (`decide_put_user`
  in `channel_authz.rs`, and the membership write in `buzz-db` `channel_members.rs`: "Any active member may extend
  private-channel access with an ordinary role"). The Backers room is founder-admitted by convention only.
  So "they apply again and the founder declines" holds only once a room has an **owner-approval admission mode** in
  which only owners and admins may add members. That mode is the real feature, and it changes admission policy.

**Revised scope.**
- **Pilot (invite-only community, small group):** use existing community invitations and the private Team and Backers
  rooms; reporting on boards and DMs; board removals that other readers see; defined personal mute and block; a sanitized
  action log; the Testnet chip; a named abuse contact (the operator) and an appeal route. A2 (sticky room restriction) is
  dropped for the pilot. Moderator roles, peer suspension, emergency override and election machinery stay deferred.
- **Report privacy (A1) downgraded:** with one operator the engineering waits until there are other admins or room
  moderators. What cannot wait is the wording: the operator sees who reported and the note, and a report against the
  operator has no independent route. The in-app report dialog ("Only this community's moderators will see this") is
  accurate; the sentence in `VISION_MODERATION.md` that a report is "never visible to the person you reported" is not, and
  should be corrected or qualified (a documentation change, for the user to approve).
- **Public social launch:** keep community entry accessible; add approval only to rooms that need it. Private rooms hide
  their history; the model has no "public reading, approved posting" mode, so say so.
- **Later:** "Request access" for a room, stored as a pending request visible to the room's owners and admins, with an
  owner-approval admission mode (and the same for a community). Approving reuses the existing add-member action; declining
  adds nothing. Confirmed-backer admission only once the bid is verified on chain with a valid key binding, never from a
  signed bid announcement. A durable restriction is added only if usage shows approval gating is not enough.
- **Invite-only is the pilot, not the architecture.** It limits discovery, public discussion and evidence access (C1), so
  it must not quietly become the investor product's permanent model.
