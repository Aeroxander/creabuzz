# Social first, then contributor projects, then the audited raise (2026-10-19)

You asked for boards to feel like a real Reddit replacement inside the Twitter-like feed, for the chat and feed to be
polished, and then for an order of launch: the social MVP first, then a few on-chain features that do not raise money
(a contributor-only project whose token is shared out by contribution), and the fundraising projects last, after an
audit, more tests and simulations.

This changes the order in [PILOT.md](PILOT.md), which put the raise first. Where the two disagree, this order wins
until you say otherwise: the pilot's format is unchanged, it is just no longer the first thing people meet.

## 1. Boards in the feed (built, D63)

- **Home has a Boards tab**: every board's posts on this server in one list, sorted Hot, New or Top, with each board one
  tap away and a New post that asks which board it goes on. You can vote from the list; the vote goes to the post's own
  board.
- **Everyone shows "Hot on the boards"**: the three hottest board posts from the last week sit above the short posts, so
  long discussions are part of the feed and nobody has to know where to look.
- **Each board has its own page** at `/b/<board>`, beside Home rather than inside a workspace, and a post is linkable
  (`/b/<board>?post=<id>`). The workspace sidebar still lists boards and opens the same board.
- **Forum feel**: each post in a list shows the author's picture large (44px) with name, board and time, the title and
  the first lines of the text; an opened post shows the author's picture at 64px; replies at 36px.
- Hot is score lifted by recency (a post needs ten times the votes to stay level with one 12.5 hours younger) and a
  little by replies. Posts about a DAO decision are never ranked by votes, as before.

Likes stay on short posts and up/down votes stay on board posts: one feed, two kinds of post, each with the engagement
that fits it (D61 still holds for short posts).

## 2. What boards still lack before they replace Reddit

In rough order of how much a regular Reddit user would miss each:

1. **Join a board** and a "Your boards" view of only the boards you joined (today the tab shows every board you can
   read). Open boards should be one tap to join.
2. **Anyone can start a board.** Today only a community's owners and admins can. A product call: Reddit lets anyone
   create one; with open communities (D33) that also means spam boards, so it likely needs a small rule (an account a few
   days old, a cap per person, owners can close one).
3. **Pictures and links in posts**, with a thumbnail in the list (link posts and image posts are most of Reddit).
4. **Top by period** (today / this week / all time) and paging past the newest 150 posts.
5. **Live "N new posts"** on the Boards tab (a single board is live already; the front page is a snapshot).
6. **Profiles show board posts and a score** (the sum of votes on what you wrote), plus "joined" and post count next to
   the large picture: the old forum author panel.
7. **Pin and lock a thread, board rules** in a side panel, and notifications when someone replies to your post.
8. **Work and fun** (you said later): a board says whether it is for work or for fun, and Home can show one, the other or
   both. Cheap to add once boards carry a kind; worth it once there are enough boards to annoy people.

The chat and the short-post feed are close to Slack and X already. The gaps worth closing for the MVP: chat threads and
unread markers that survive a reload, search across posts and boards from the top bar, and replies to board posts in
notifications (shared with item 7).

## 3. Launching the social MVP

What has to be true before strangers use it (hosting and mainnet are yours, as before):

- One run of the whole social path on the hosted server with three real accounts: sign up, post, follow, start a board
  discussion, vote, reply, report, remove, ban.
- Seed content: a few boards with real first posts (film-making, music, apps and protocols, startups, matching the first
  ten users), so the first visitor does not land on an empty room.
- Moderation that works without you online: owners and admins can remove and ban (built), reports reach someone
  (built), and a rate limit on new accounts posting.
- Terms of use and a privacy note on the sign-up screen.
- The money screens stay behind the Testnet tag.

## 4. Contributor projects: a token earned by work, with no raise

Most of this exists already on the chain side: a project's DAO can open a work budget that pays in Shares (not money),
contributors claim tasks, reviewers accept the work, and the Shares are awarded (`scripts/cli-no-raise-e2e.sh` runs that
whole journey; the Work tab and claim form are in the web app). What is missing for it to be a product:

- A **"Start a contributor project"** path in Start that sets up the DAO with no sale at all, says plainly that it cannot
  raise money, and opens a first work budget.
- A **contribution page**: who earned how much of the token and for what, from the accepted claims.
- A rule for **when the token can be traded**, if ever. Without a market, the legal and audit exposure is far smaller,
  which is the reason to ship this before the raise.
- The contracts it uses (DAO, work budgets, Shares) are a smaller audit scope than the raise; on mainnet they still need
  that audit first.

## 5. The raise, after an audit

- **Audit scope**: the sale, DAO launch kit, patched DAO, Shares token and its lock guard, work budgets, the milestone
  challenge lock, the reviewer bond. Freeze the contracts before sending them.
- **Tests**: invariant and fuzz tests in Forge for the money paths (nothing leaves the treasury without a passed vote; a
  locked Share never moves; leaving pays exactly the screen's preview; a challenge cannot unlock what an upheld objection
  burns).
- **Simulations**: many agents bidding, voting, leaving and objecting on a forked chain, to find the orders of events the
  journeys do not try (the reviews found three of those by hand: D57, D58, D51).
- Then a mainnet launch with one project, a cap on the raise, and the unaudited notice replaced by the audit report.
