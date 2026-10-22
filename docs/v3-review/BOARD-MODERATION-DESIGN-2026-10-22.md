# Board moderation run by a project's holders: a design to decide on (2026-10-22)

Status: **proposal, nothing built.** Once you decide, the parts you accept get a decision number in
[DECISIONS.md](DECISIONS.md) and are built in the order of section 6.

You asked for decentralized moderation of boards, especially the boards of contributor projects, where no money moves
and the project's holders could run the board themselves: people vote on who moderates, and holders can overturn an
action or remove a moderator, without it turning into people banning each other for no reason.

This fits what [VISION_MODERATION.md](../../VISION_MODERATION.md) already plans: today there are two roles (owners and
admins), a moderator tier is meant to come later "as a policy change, not a rewrite", and restrictions limited to one
room are listed as not built. It also names the gap this design must close first: a ban must never stand between a
holder and the evidence they need to object, vote or leave.

## 1. What there is today

- **One place decides every moderation permission:** `authorize_moderation_action` in
  `crates/buzz-relay/src/handlers/moderation_authz.rs`. Community owners and admins may do everything community-wide; a
  channel's (a board's) own owner and admin may delete messages and remove people in that channel only. An admin cannot
  ban or time out the owner or another admin.
- **Moderation commands** are signed events the server validates and runs, never stores as posts: ban, unban, timeout,
  untimeout, resolve a report (kinds 9040 to 9044), plus NIP-29 delete (9005) and remove user (9001). Each accepted
  command writes an audit row (`moderation_actions`); a removed post leaves a tombstone; the person affected is told.
- **Reports** are private, reach only owners and admins, and never act on their own.
- **A timeout or ban covers the whole community.** There is no board-only restriction, no lock, no pin and no visible
  board rules.
- **Wallets:** the server verifies a wallet with sign-in-with-wallet and the signed binding record (kind 37017), and it
  can already reach a chain node (`BUZZ_EVM_RPC_URL`, used to check smart-account signatures).

## 2. The model

**Elected moderators act quickly; holders can overturn and remove them by vote.** Representative, not direct: a vote on
every action is too slow for spam, and making every action a vote is how people end up banning each other.

| Who | Does what | How fast |
|---|---|---|
| A board's moderators | Lock or unlock a thread, pin or unpin, remove a post (tombstone), mute someone on this board for up to 7 days | At once |
| The project's holders, by a DAO vote | Appoint the moderators (with a term), remove one, overturn one action | One vote, a few days |
| Community owners and admins | Everything they can do today, community-wide | At once |
| Whoever runs the server | Illegal content and platform safety, which no vote can change | Its own process |

- **Where it applies:** boards bound to a project's DAO (section 4). General, community-wide rules and private rooms stay
  with the community's owners and admins.
- **Votes are Shares.** In a contributor project they are earned by reviewed work, so they are far harder to fake than
  social points or new accounts. The consequence must be said plainly: at the start the founder holds most Shares, so
  the founder effectively chooses the first moderators, as with every other vote ("Who decides right now").
- **Before any vote**, a board's moderators are whoever its owners and admins appointed (section 6, step 2), so a board
  works from day one and the DAO takes over when it chooses to.

## 3. Guard rails

Enforced by the server, not left to good manners:

1. **Limited to one board.** A moderator's actions reach only the board they moderate.
2. **Not for themselves or against each other.** A moderator cannot lift their own mute, act against another moderator,
   or act against the community's owners and admins (as an admin cannot act against the owner or another admin today).
3. **Mutes expire.** A board mute lasts at most 7 days. Anything longer needs a second moderator to confirm it within a
   day, or a holder vote.
4. **A limit per moderator,** for example 20 actions an hour, so a captured or careless account cannot sweep a board.
5. **Everything is visible.** A public moderation log for the board (what, on whom, when, the sanitized reason, by
   which moderator), the tombstone in the thread, and the notice to the person affected, as the vision requires.
   Reports stay private.
6. **Appeal by vote.** Anyone affected can ask the holders to overturn an action; a passed vote restores the post or lifts
   the mute.
7. **Terms run out.** An appointment carries an end date (for example 90 days), so moderators face the vote again.
8. **Moderation never touches money or votes.** No board action may stop a holder from reading a decision's evidence,
   voting on it, or leaving the DAO. This needs the record reader in section 5, so the DAO-run part waits for it.
9. **Unknown is not permission.** If the server cannot read a board's moderators from the chain, they cannot act until it
   can; owners and admins still can.

## 4. How the server enforces a DAO's moderator list

A DAO cannot sign Nostr events, and today the server only trusts the community's own roster. Three ways, in order of
recommendation:

**A. The server reads the list from the chain (recommended).**

- **A tiny contract that holds no money**, `BoardModerators`, where a DAO records its board's moderators:
  `setModerators(boardId, wallets, termEnds)` and `overturn(boardId, actionId)`. Each DAO's entries are keyed by the
  caller, so only that DAO's own vote can change them and the contract needs no other access control. It emits
  `ModeratorsSet` and `Overturned`.
- **A board is bound to one DAO** by its metadata (the board's kind 39000 record names the chain and the DAO address),
  set by the community's owner. The server honors the DAO's list only for a board that names that DAO.
- **The server checks** a moderator's command by looking up the signer's verified wallet (the kind 37017 binding) in that
  DAO's current list, through the chain node it can already reach, cached for a minute and refreshed on the contract's
  events. This becomes one more authority in `authorize_moderation_action` (`BoardModerator`), with the capabilities of
  section 2 and the guard rails of section 3.
- **An overturn** passed by the holders is read the same way: the server restores the post or lifts the mute and writes
  the audit row.
- Cost: the server depends on a chain node for this (it already can), and a new contract the server trusts. It holds no
  value, but it belongs in the audit scope, with a few lines of tests.

**B. The community owner applies the result.** The vote passes and the owner appoints the people by hand. Simple, but
the owner can ignore the vote: it is not decentralized.

**C. Clients honor the moderators, not the server.** Each app hides what the DAO's moderators labelled (NIP-32 labels),
and the server keeps everything. It works across many servers, but removal is only cosmetic and spam still reaches
every server. Worth adding later beside A, not instead of it.

**The vote itself.** Appointing, removing and overturning are DAO decisions with new kinds in the app's decision form. A
call to a new contract goes through the full vote today (about three and a half days from opening to running); putting
it on the lighter lane would mean changing `AllocationVoting.boundedAction`, which is in the audited scope. Start with
the full vote.

**The escape hatch.** The community's owner set the binding and can remove it: that keeps the community and safety layers
above the board, but it lets an owner take a board back. The binding's removal should take effect only after a notice
(for example 7 days, shown on the board) and be written to the public log, so holders see it coming.

## 5. The record reader (the prerequisite)

Today a community ban ends a key's access to everything in the community, including the project's public records.
Before a DAO's own moderators can mute or remove anyone, a holder must keep a way to read what they need as a holder:

- **What it reads:** only what a holder needs to act on the DAO: the project's record, its updates (including the
  evidence behind claims), its decisions' discussion threads, and the work areas' words. Never chats, private rooms or
  other boards.
- **How:** a read path on the server, not tied to community membership, that serves those records for one DAO to anyone
  holding its Shares (proved by the verified wallet) or to everyone when the project marks them public, read-only.
- **Still to decide:** whether that path should also be mirrored somewhere outside this server, so a server that goes
  away or turns hostile does not take the evidence with it. Hashes on the chain let anyone check a copy, but they cannot
  rebuild a lost one.

## 6. Build order (each step useful on its own)

| Step | What | Needs a contract | Size |
|---|---|---|---|
| 1 | **Lock, pin and visible rules** for boards; **board-only mutes** (up to 7 days); the **public board moderation log**. For today's owners and admins and boards' own owners and admins. New command kinds in `buzz-core/src/kind.rs`, the rules in the board's metadata, the app's board page and thread | No | Medium |
| 2 | **A moderator role per board, appointed by the owner**: the capability set of section 2 and the guard rails of section 3, as a new authority in `authorize_moderation_action` | No | Small to medium |
| 3 | **The record reader** of section 5 | No | Medium |
| 4 | **Moderators elected by a project's DAO**: `BoardModerators`, the board-to-DAO binding with its notice, the server's chain check, and Appoint, Remove and Overturn in the app's decision form | Yes | Large |
| 5 | Later, if wanted: clients honoring a DAO's moderators across servers (NIP-32 labels) | No | Medium |

Steps 1 and 2 could land with or soon after the pilot, and the pilot would show whether boards need more than appointed
moderators. Step 4 is worth building only if they do.

## 7. Decisions for you

1. **The model:** elected moderators with holder overturn and removal (section 2), rather than a vote on every action.
2. **Enforcement:** the server reads the DAO's list from the chain (A), with a new contract that holds no money but is
   trusted by the server and audited.
3. **The numbers:** a 7-day longest mute without a second moderator, a 90-day term, 20 actions an hour, a 7-day notice
   before a board leaves its DAO.
4. **Votes by Shares,** accepting that the founder chooses the first moderators in practice, said plainly.
5. **The record reader:** a read path on this server first; whether to mirror it elsewhere too.
6. **Where to start:** steps 1 and 2 now, step 4 only if the pilot shows it is needed.
