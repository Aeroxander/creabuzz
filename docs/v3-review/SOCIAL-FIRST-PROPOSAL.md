# A social-first, peer-allocated, role-based model (proposal)

Status: **proposal for owner decision.** Nothing here is built, decided or deployed. Date: 2026-11-08. Branch
`v4-governance-rework`. The build freeze (D137) stands until you say otherwise; this document asks you to say so for one
small, no-money piece (decision 1).

## Summary

You said the product is too cumbersome and that one founder should set less. I agree with both, and I would start with
the social side. The smallest useful step is **a vouch**: one person says "I know this person and would trust them with a
small job", signed and visible to the community. The Start form's typed line "How you know each reviewer" goes, and the
reviewer picker shows who vouches for each candidate instead, starting with the people you already follow. This needs no
new contract and could ship on the Sepolia pilot in about two weeks (my guess; nobody who has read the server code has
sized it). Then, only if the pilot shows people use it: **roles as dated seats** (borrowing the idea behind Hats, not its
code) that propose the next reviewer panel, and **Thanks rounds** (borrowing the idea behind Coordinape) where everyone
shares out 100 Thanks and the result *advises* the award vote. I do not recommend letting peers create Shares directly
yet. Shares are votes, so that would let a small group of friends take control of a project, and the two designs I
reviewed do not stop that in a community of five people. Everything numeric below is my starting guess and is yours to
change.

## What I read, and what was missing

I read VISION.md, VISION_PROJECTS.md, PLAIN-WORDS.md, NEXT-GEN-DAO.md, D137, D73, D76, D79 and D174 in DECISIONS.md, STATUS.md,
the pilot runbook, and four working papers: what Creaton does today (r-creaton.md) and three designs (social, roles,
allocation). **The research files on Hats, Coordinape and awesome-daos (r-hats.md, r-coordinape.md, r-daos.md) did not
exist when I looked, and the three designers did not have them either.** So I checked what I could myself:

- awesome-daos is a general link list (platforms, tools, papers). It has no design to copy; the one relevant entry is
  Colony, "reputation-based governance". I treated it as a reading list, not a source.
- Coordinape's public docs (first part only): each member gets 100 GIVE, sends it to teammates during a period, unspent
  GIVE disappears, and the admin's budget is split by each person's share of the total received. People can opt out of
  receiving. Vouching to join is optional. They recommend circles of at least three. **The docs give no guidance on
  collusion or fake accounts.** Note what this means: in Coordinape the admin still chooses the money; peers choose only
  how it is split.
- Hats: I rely on the roles designer's reading of the Hats README (a role is a non-transferable token, someone can
  remove it, and other contracts read it; the core is AGPL-licensed). I did not verify it myself.

## Words, defined once

- **Vouch**: a signed statement from one member about another: "I know them and would trust them with a small job."
  No score, no stars, no money. Withdrawable.
- **Trust graph**: the web of who vouched for whom. Not a score; just the records.
- **Role** or **seat**: a named job (reviewer, the person who accepts work for review) held for a stated time by a person
  others put there. A seat gives no votes and no Shares.
- **Thanks**: a fixed amount (100) each member shares out to others in a round. Not money, not Shares.
- **Round**: a repeating period (I suggest 14 days) after which the Thanks are counted.
- **Peer**: any member acting as one among equals, not as the founder.

## 1. What we take from each idea, and what we leave

| Source | Take | Leave | Why |
|---|---|---|---|
| Trust graph | One kind of record: the vouch. Shown, not scored. Seen first through people you already follow. Later, a way to say who counts as an established member. | A global score. Seeds and "standing" before anything depends on them. Fading weights. Gating the nav. | A score invites gaming and tells people they are ranked. Showing who vouched, seen through your own follows, already resists fake accounts for that viewer. |
| Hats | The idea that a role is a seat: it has a stated end, it is separate from Shares and money, and stepping down is not the same as being removed for cause. Plain names (reviewer; person who accepts work). | Deploying Hats. Writing our own role contract (about 350 lines, and it changes four contracts we plan to audit). A role tree, admin roles, a steward seat, five tunable dials. | The reviewer list can already change every 90 days when a new work budget is voted. Seats can feed that moment without any new contract. |
| Coordinape | An equal allowance for everyone. Hidden totals until the close. Opt-out. A rhythm of recognition. The fact that peers split a pool someone else sized. | Peers creating Shares directly. A hold-back until the next round. Admin power to remove people. | Coordinape pays money from a budget. Our Shares are votes, so splitting them is a power grab target, not a bonus. |

The unlock schedule you mentioned: in the hosted pilot the founder sets **no** unlock schedule. Awards arrive in full
after the 7-day window. The only founder schedule is on the weekly-sale kit (Start fields for days before selling and days to
unlock), which is off in the hosted build and which cannot be changed once the project is made. What the founder sets today is
the size of the numbers (starting Shares, work budget, most per work area), the reviewers, and who accepts work (the
founder, for every first work area). Those are what slices 1 to 3 loosen.

## 2. The judge's review: where the three designs hand-wave

### 2.1 Fake accounts (sybil)

- **Two real members who collude can mint a crowd.** The social design needs 2 vouches to "have standing" and caps each
  person at 5 live vouches. Two accomplices vouch five fake accounts each (10 vouches, 5 accounts with standing). Those five
  can then vouch up to 25 more. The cap slows growth; it does not stop it. The design admits it cannot prove one person per
  account, and says standing grants no money or votes. That is the real defence: **nothing important may rest on the
  graph alone.** Anything that depends on it (who can start a project, who is suggested as a reviewer) must be read as
  "people vouched for this account", never "this is a real, separate person".
- **The invite trick does not work as written.** The social design says accepting an invite counts as the inviter's first
  vouch. A vouch is signed by the voucher, and the invite link cannot sign for them later (the new person's key is not known
  when the link is made). Workable version: when someone joins by your link, you get a card, "Sam joined with your link.
  Vouch for Sam?", one tap.
- **A withdrawn vouch is not private in a small group.** The design promises no notice, but "the count dropped from 2 to 1"
  tells a five-person group who did it.
- **Agent accounts "never vouch"** needs a reliable way to tell an agent from a person. Agent ownership proofs exist for
  agents made through the product; I did not verify that a web sign-up can be classified.
- **Roles by backing** (the roles design) counts holders. In the first 90 days the only holder is the founder, then those
  the founder's own votes awarded Shares to. The design says so itself: it dates the founder's control, it does not remove it.

### 2.2 Collusion in Thanks rounds

- **Three friends can take a small round.** The allocation design caps one person at 40% of the pool. Three people each
  at 40% is 120%, so three colluders take everything. Its reciprocity discount only catches pairs; a triangle (A thanks B,
  B thanks C, C thanks A) passes. In a group of five, three friends are a majority of the group.
- **The damage is votes, not just money.** Shares are votes. A ring that wins two or three rounds controls reviewer
  changes, budget renewal and every award. Earned Shares are never taken back (D73 and the "earned money survives" rule), so
  there is no undo. In Coordinape the worst case is a skewed payout; here it is control.
- **The worked example is not a typical outcome.** The designer searched for Thanks that divide into round numbers
  (the working file `sim.py`), then chose from them. It shows the rules, not what groups will do.
- **Its own numbers show slow change of control.** The founder still holds 55% after two rounds. Peer rounds change who
  decides awards quickly and who decides votes slowly.
- **Where the Thanks live.** In the early steps they are signed posts on the Creaton server. A signature proves who wrote
  one, not that the server shows you all of them (NEXT-GEN-DAO "Trust"). Whoever runs the server is a quiet gatekeeper of
  who is a member and which Thanks count. The designer lists mitigations (receipts people hold, a published list) but the real
  fix is on-chain Thanks, which is the largest and last item.
- **The panel is awkward.** Under the one-agreement path, everyone named in the split is barred from reviewing that round,
  and in a small group that is nearly everyone. The proposed fix narrows a safety rule in an audited contract; I would not do
  that to chase convenience.
- **Several rules are extra weight.** A hold-back of 20% until the next round, half weight in a person's first round, a
  reciprocity discount and a 40% cap are four rules a founder must explain in plain words to people who just want to say thanks.
  That is the cumbersome you asked me to remove.

### 2.3 Who bootstraps, and a community of five

- **Seeds are still one person's choice.** The social design names "seeds", the first members, on the server's settings page.
  That is honest, and it is still one person (the community owner). I would not hide that. I would delay needing seeds until
  something depends on them (slice 2).
- **A gate at 12 people backfires.** The social design hides Start until 12 people have standing. The pilot's own social run is
  three to six people, so that rule would block the very communities we are testing. The gate exists to protect against
  strangers; five friends have none. I reverse it: small groups need no gate, large ones do (slice 2).
- **Five people is a hard case, not a footnote.** The founder cannot be a reviewer, and a panel needs at least three. In a group
  of five, three of the four others are reviewers and one is left. The Start form tells the founder to pick reviewers "other
  than the ones who will do the work"; in five people that is impossible. The contract only bars a reviewer from judging their
  own piece, so reviewers can also submit work. The form hint should say so. Vouches in a group where everyone knows everyone
  carry almost no new information; the value of slice 1 there is a simpler form and a record for when strangers arrive.
- **Two or three people cannot run a Thanks round** (Coordinape recommends at least three, and the allocation design needs
  three givers). I would not run one below 8 people, even as advice.

### 2.4 What "Shares earned by peer allocation" may mean legally

I draw no conclusions. What I see for counsel (section 8): the Powers card and several screens say new Shares are "only ever
given for work the reviewers accepted"; with peer rounds that sentence is no longer true unless the reviewers' job is
redefined as checking arithmetic, and a designer-proposed hold-back until a person takes part again looks like a condition
on ownership. Both are reasons to keep peers advising, with holders voting, for as long as possible. The pilot has no money in
its budgets and is on a test network, which lowers today's stakes but not the question for later.

### 2.5 What else I found

- Both the roles and allocation designs change audited or planned-audit contracts (the roles design touches four; the allocation
  design touches the agreed-reward path, which is a development candidate and not deployed). The constraint "no new audited
  contract if possible" is better met by not putting this on chain yet.
- A 90-day budget already ends and is renewed by a full vote. That is the natural place to change the reviewer list. The
  roles design builds a contract to change it continuously; seats that only *propose* the next panel, with the vote as the
  check, get most of the value for none of the cost.
- Dilution: new Shares lower what each existing Share gets back on leaving. Contributor budgets hold no money, so the effect is nil
  today, but it becomes real the day a project holds funds. Any pool size must be read with that in mind.

## 3. Recommended first slice (a): "Vouch, and a shorter Start"

Small enough for about two weeks. No contract, no change to the money rules, no change to leaving.

1. **The vouch record.** A new signed record on the server, members only, one per pair, newest wins, withdrawable, no note,
   no score. Needs a new event kind registered on the server (the pattern exists for the score and contribution records;
   how much server work it is, I did not check). No expiry yet: nothing depends on age until slice 2.
2. **The buttons.** On a profile: "Vouch for Sam" with a one-time plain explanation. A line: "Vouched for by 3 people, 1
   you follow." Names are shown to the person vouched for and to members who follow the voucher. The card "Sam joined with
   your link. Vouch for Sam?" for inviters.
3. **The reviewer picker** shows that line for each candidate and sorts people you follow, then people vouched for, first. It
   lists everyone it lists today. **No standing, no seeds, no gating** in this slice; so no bootstrapping problem yet.
4. **The Contributions tab shows derived ties** where the typed sentence used to be: "Reviewer Sam and the founder have
   vouched for each other." It also says plainly that no vouch does not mean no tie. Old projects keep their saved text.
5. **Start gets shorter** (section 4). Numbers are collapsed behind defaults, still readable and editable.
6. **Used in a second pilot run, not the one running now.** Changing the form inside the first run would spoil the
   comparison D137 wants. Run the same measures on both: time to finish Start, how many reviewers were picked from the list
   rather than pasted, reviewer disagreements, and whether testers can say back what a vouch means.

What slice 1 does not do: no Hats, no Thanks, no change to who can start a project, no hidden navigation, no number moved.

## 4. (c) The Start form, field by field, now

Reference: `web/src/features/start/ui/ContributorStartPage.tsx` (lines from the 2026-11-08 reading). "Collapse" means
moved under one fold, "Change the starting numbers", with the same default and the same limits. Nothing economic changes.

| Field on screen | Today | Slice 1 |
|---|---|---|
| Project name | Required, 2 to 60 characters | **Keep** |
| What it is | Required, 10 to 140 characters | **Keep** |
| Short name | Required, 2 to 8 letters or digits | **Fill in from the name; collapse** |
| Your starting Shares | Default 100,000; at most a third of the work budget | **Collapse.** The "At the start" sentence stays in view |
| Shares available for work | Default 300,000 | **Collapse** |
| Most for one work area | Default 25,000 | **Collapse** |
| Reviewers | 3 to 32 accounts, picker or pasted address | **Keep as the one real choice.** Picker first, with the vouch line. Keep "add by address" under the fold until we confirm every pilot account has a linked payment account |
| How many reviewers must agree | Blank means more than half, at least 2 | **Collapse**; the sentence stays in the summary |
| **How you know each reviewer** | Required free text, 10 to 2000 characters | **Remove** (replaced by item 4 in section 3) |
| First work areas | 1 to 8 rows | **Start with one row; "Add another" under the fold** |
| Work area name; what finished work looks like | Required; 5 to 280 characters; fixed on the network | **Keep** |
| Shares for the work area | Each at most the per-area limit | **Collapse** |
| Weekly sale fields (lot size, days before selling, days to unlock) | Only on the weekly-sale kit, off in hosted | **Stay off.** Not a form field in any slice (decision 9) |
| Built on / what you ask in return | Only if remixes are offered | **Leave as is** (off in hosted) |
| "At the start" and "If the whole work budget is awarded" | Computed disclosure | **Keep, always in view.** A disclosure must not be hidden or moved away from the button it guards (PLAIN-WORDS section 4) |
| "What it is" card, "Start over" | | **Shorten the card;** keep the button |

Net: three typed answers (name, one sentence, first piece of work) and one choice (reviewers), down from eleven fields.
Copy rule for every new string: plain words, no "earn", "grow" or "benefit" near Shares, "server" not "relay", and the term
table in PLAIN-WORDS applies. Draft vouch text: "To vouch for Sam is to say you know them and would trust them with a
small job. Sam can see that you did. You can take it back at any time." Buttons: "Vouch for Sam", "Cancel".

## 5. (b) The second and third slices

Each needs the one before to have been used, and a decision from you.

### Slice 2: dated seats and a gate for larger groups (weeks 3 to 8; still no contract)

- **Seats as records.** Two seats: *reviewer* and *person who accepts work for a work area*. A seat has a holder, a start, an
  end (90 days, matching the budget), and who put them there. Putting someone in a seat needs backing from people who have
  Shares (heads, not Share weight), or the founder in the first 90 days. Stepping down is free of blame; removal for cause is a
  vote.
- **Seats propose; the vote decides.** When a new 90-day work budget is made, its reviewer list is pre-filled from the seats
  in force. The full vote on the budget stays the check and shows every address. No role contract. The on-chain panel stays
  fixed per budget, as now.
- **Who accepts work.** Start lets the founder pick someone other than themselves for the first work area (the kit already
  takes any address; the app fixes it to the founder). This removes the founder as the only door to review.
- **Standing and seeds, only now.** Standing means at least 2 vouches from people with standing; seeds are the community owner
  plus those the owner invited in the first week, published. Vouches last 180 days unless renewed with one tap. A person whose
  vouchee is removed for abuse is told, and cannot vouch for 30 days.
- **Gate Start by standing only in groups of 12 or more with standing.** Under 12, anyone signed in can start.
- **Evidence needed first:** reviewers used the picker; vouches were given without being asked; nobody read the vouch as a score.

### Slice 3: Thanks rounds as advice (after the pilot report; still no contract)

- First a **paper round** with 5 to 8 testers (a form and a spreadsheet, no code) right after the contributor run.
- Then an app version: each member gets 100 Thanks, at most 50 to one person, none to themselves; totals hidden until the close;
  results public after; opt-out. **Result is advice only.** The award form pre-fills "Shares to award" from the round, and holders
  vote as they do today (bounded lane, reviewers, 7-day window, freeze vote, leaving). The page shows the gap between what peers
  suggested and what holders awarded. That gap is the new honesty: while the founder is the only voter, the founder can still
  decide, but everyone can see when they overrode the group.
- Not in slice 3: pool sizes, a per-person cap, reciprocity rules, hold-back. Pick them from the paper round's data, and
  only if a later slice mints directly.

### Later, only if all the data and counsel say yes (not scheduled)

Thanks results setting an on-chain split of new Shares (needs the split limit raised from 4 to 16, a cap on one agreement, and
a decision about who may review; touches the agreed-reward path, not deployed). A role contract. On-chain Thanks. Each needs its
own audit scope, a new project kit (a deployed budget cannot be changed), and your decision.

## 6. What to say to counsel (e)

Flags only; no conclusions, and nothing here changes the trading switch (off by default).

1. **Vouch records.** A members-only record of who vouches for whom is personal data. How would erasure requests work when the
   first copy may sit in the tamper-evident audit log? Is a withdrawn vouch still disclosed in a way that identifies the
   person (the count drops)?
2. **Replacing a typed ties statement with derived facts.** The reviewer independence line (D39) and the Contributions tab
   currently give the founder's words. Does a derived "vouched for each other" line, which says nothing when there is no vouch,
   change what we are telling holders and contributors? Should an optional typed line stay for conflicts?
3. **Collapsing the starting numbers.** Do the defaults, readable but not on the main screen, change the disclosure that guards
   the Create button? The "At the start" paragraph stays visible either way.
4. **Peer-set awards.** (Later slices.) If Shares are made because peers thanked someone, does the description "given for
   work the reviewers accepted" still hold? Is a hold-back until later participation a condition on ownership? Who is the
   issuer when the group, not the founder, decides? Do recipients need to say yes before being named?
5. **Recognition copy.** Does the word "Thanks", or a visible total, read as a promise or a hint of return? Draft copy avoids
   "earn", "grow", "benefit" and "upside" next to Shares, but counsel should read it.
6. **Roles.** Whether naming a person to a seat that decides which work is accepted needs wording to the seat holder, and
   whether a public record of removal for cause about a named person has accuracy or defamation duties.
7. **Tax and reporting** for people who receive Shares for contributions, even at zero value on a test network.
8. **Hats licence.** Hats' core is AGPL. We would copy ideas only. Please confirm that is enough and that using a deployed
   copy as a dependency copies nothing.
9. **Accounts that are agents,** and people who may be minors, being thanked or vouched for.

## 7. (d) What you must decide

Each with my recommendation.

1. **May the social layer (vouch, picker line, shorter Start) be built despite D137, on the understanding that it has no
   contract, no money and no change to the running pilot?** Yes; use it only in a second pilot run.
2. **One meaning for a vouch** ("I know them and would trust them with a small job"), signed, members only, no score, no note?
   Yes.
3. **Who sees the voucher's name?** The person vouched for, and members who follow the voucher. A count for everyone else.
4. **Starting numbers:** at most 5 live vouches per person; later, 2 to have standing and 180 days. All guesses. Accept as
   guesses to test?
5. **Delete "How you know each reviewer" and collapse the starting numbers (not remove them)?** Yes. Removing the freedom to
   change them is a later, separate call.
6. **Start gate:** not in slice 1. Later, gate only at 12 or more people with standing. Agree?
7. **Roles:** copy the idea (dated seats that propose the next panel), do not deploy Hats and do not write a role contract
   before the pilots. Yes.
8. **Peers advise, holders decide.** No direct creation of Shares by peer rounds until after the data, a paper round and
   counsel. Yes. (If you want the opposite, the group must be at least 8 and the pool a number you set; I would not start there.)
9. **The founder's unlock schedule:** not a Start field in any form. If the weekly-sale kit is ever turned on, the days are
   fixed rules shown to everyone, not typed by the founder. The 180-day figure is your proposal; confirm or change it.
10. **Run a paper Thanks round after the contributor run,** with the same testers? Yes, and publish the measures.

## 8. (f) Risks, and what would make us stop

| Risk | Stop or rethink if |
|---|---|
| The vouch means nothing in tiny groups; people tap it because asked | Under half of testers in the second run give a vouch unprompted, or fewer than 4 of 5 can say back what it means |
| Fake accounts through collusion (two accomplices are enough) | Any screen, copy or code treats vouches as proof of one real person, or lets a vouch count unlock money, votes or Shares |
| The graph is held by the server operator | Anyone suggests it as a neutral source of truth; keep calling it "what members recorded here" |
| Social cost: exclusion, begging for vouches, retaliation | Reports of pressure in the pilot; quota or visibility changes before anything gates |
| Derived ties hide a real conflict (no vouch is not no tie) | A pilot reviewer is found to be a close relation of the founder and the page showed nothing; restore an optional typed line |
| Complexity returns (our own pattern, per D137) | Start takes longer than today, or testers need an explanation of more than three terms |
| Measurement confound | We change the form during the first run |
| Thanks capture: friends win rounds and then control votes | In the paper round, one person gets over 40% of Thanks, more than 40% of Thanks are reciprocal, or fewer than 70% of testers give. Stay advice-only or drop it |
| Legal posture of peer-set Shares | Counsel advises against it: Thanks stay recognition for good |
| Seats used to push out critics | A removal for cause that the holders did not vote for, or two such disputes |
| Server work larger than I assume | The new record takes more than about a sprint; cut the sort order and ship the record and button first |
| Dilution when a budget holds money | The first project with a funded budget: re-read every pool and round number with the exit value in view |

**Overall stop:** if the second pilot run is not faster to start and no easier to explain than the first, stop and go back
to the old form. The old form is kept in the history and the running pilot is untouched.

## 9. Files and sources

This proposal draws on the working papers `r-creaton.md`, `d-social.md`, `d-roles.md`, `d-allocation.md` and `sim.py` in the
session's scratchpad (they are not in the repository). Facts about the code come from `r-creaton.md`, which read the code and
did not run it. Items marked as unverified above (server effort, linked payment accounts for pilot users, the agent-account test)
should be checked before slice 1 is scheduled.
