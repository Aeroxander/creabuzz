# A restricted holder's evidence and rights (outside review A 4.1, critique 6)

Written 2026-11-01. The model first, then what the code does today, then the manual fallback for the testnet pilot and
the hand test that accepts it. Nothing here makes private evidence public.

## The intended model

Moderation decides who may take part in a community's conversation; it never decides whether a holder may use the
rights their Shares give them. A holder who is muted, banned or removed from a community keeps every right that lives
on the chain (to vote, to object to work by opening a dispute, to leave with their share) and must keep a way to read
what they need to use those rights: the words and evidence of each piece of work under review or up for an award, the
words of each decision open for a vote, and what the treasury holds. That reading is narrow and private: one holder, one
DAO, only those records, never chats, private rooms or other boards, and never published for everyone. The product
answer is a holder's record reader that a ban does not cover (BOARD-MODERATION-DESIGN-2026-10-22.md, section 5); it is
not built. Until it is, the bounded testnet pilot uses the manual fallback below, and the fallback counts only once its
hand test has passed.

## What a restriction does today (from the code)

| Restriction | The server | Reading in the web app | Chain rights |
|---|---|---|---|
| **Mute everywhere** (the server's "timeout", kind 9042; the moderation queue's "Mute everywhere", `buzz moderation timeout`) | Refuses their writes; reads stay allowed (`deny_banned` in `crates/buzz-relay/src/api/mod.rs`: "a timeout blocks writes ... while reads stay allowed"; the CLI calls it "a write-block, not a disconnect") | Everything they could read before | Unchanged |
| **Ban** (kind 9040) | Refuses their sign-in on the live connection ("blocked: you are banned"), every HTTP request (`deny_banned`, 403) and member-only pictures (`api/media.rs`) | Nothing: the app shows "The people who run it have turned you away" with only **All communities** (`CommunityHomePage.tsx`, `BannedNotice`). Project pages, evidence and Needs you all load from the server (`queryEvents(relayWsUrl(), ...)` in `use-launches.ts` and `use-evidence.ts`) | Unchanged on the chain, but the app cannot reach them |
| **Removed from an invite-only community** | Refuses them as a non-member (`relay_membership_required`) | Nothing, as for a ban | As for a ban |

What still works for a banned or removed holder:

- **The chain itself.** Shares, claims, reviews, votes and the treasury are public chain state. The evidence **hash**
  of each claim is on the chain (`ClaimStake.claims(id)`, field 5); the evidence **text** is on the server, for members
  only. So the chain proves a copy is genuine, but cannot supply the copy.
- **The command line, for a browser-wallet holder.** `buzz launchpad work state`, `proposal-state`, `propose`, `vote`,
  `queue`, `process`, `work freeze`/`unwind` (composes the vote that freezes a doubted claim) and `buzz org ragequit` run
  against the chain only, before any server sign-in (`crates/buzz-cli/src/lib.rs`: "chain-local ... they run before
  relay auth"). Checked 2026-11-01 with no server and no Nostr key set: each went straight to the chain node and failed
  only because the node was unreachable. Against a real local chain, `cli-no-raise-e2e` (in the pilot gate) runs
  `work state`, `propose` and `vote`; leaving with `buzz org ragequit` is run in
  `web-restricted-holder-e2e` (pilot gate), and with `cast` in `cli-milestone-e2e` and `shares-erc20c-e2e` (later set).
- **Nothing, for a passkey-account holder.** A passkey account signs only in the web app (with the bundler and
  sponsor), and the web app's project pages need the server. There is no command-line path. This is the gap the
  fallback has to close by hand.

## The manual fallback for the testnet pilot

For the operator (the server's owner), whenever a holder's social access is restricted:

1. **Prefer "Mute everywhere" for anyone who holds Shares, has open work, or sits on a review panel.** They keep
   reading everything and keep using every right in the app; only their posts are refused. Check first: the project's
   Contributions page (who holds what), Needs you or the Work tab (open work), the project's reviewers.
2. **If such a person must be banned** (threats, illegal content): ban them, then the same day, outside the app,
   message them: their Shares and rights are unchanged, and how to reach their evidence (below).
3. **Their evidence, privately, to them alone.** For each piece of work under review or up for an award, and each
   decision open for a vote, in a project where they hold Shares: open it as yourself, copy the evidence or decision
   words, and send them with the project's DAO address, the mandate (work area) address and the claim id. Send nothing
   to anyone else, and nothing that is not one of those records.
4. **They check the copy against the chain** (a browser-wallet holder, or you on their behalf while they watch):
   `cast call "$(cast call <mandate> 'claims()(address)' --rpc-url "$NODE")"
   'claims(bytes32)(address,uint256,uint256,uint8,bytes32,bytes32,uint64,uint64)' <claim id> --rpc-url "$NODE"`; the
   fifth line is the evidence hash. Hash the copy the way the app does (spaces, tabs and blank lines at either end
   removed, then the text's own bytes, so text starting with `0x` is not read as a number):
   `cast keccak "0x$(node -e 'process.stdout.write(Buffer.from(require("fs").readFileSync(process.argv[1],"utf8").trim(),"utf8").toString("hex"))' evidence.txt)"`
   must equal it. Plain `cast keccak "$(cat evidence.txt)"` is not the same hash when the copy has a leading space or
   starts with `0x`. (Checked 2026-11-01 against the app's own hash on text with a leading space, a tab and a `0x`
   start.)
5. **They use their rights.**
   - A browser-wallet holder, from the command line with a test-network wallet only (`BUZZ_EVM_RPC_URL` set to a
     Sepolia node, `BUZZ_SPENDER_KEY` to that wallet's key): read a claim with
     `buzz launchpad work state --mandate <mandate> --id <claim id>`; vote with
     `buzz launchpad vote --dao <dao> --id <decision id> --support for|against`; to object to approved work, compose a
     freeze with `buzz launchpad work freeze --dao <dao> --mandate <mandate> --claim <claim id>` and open it with
     `buzz launchpad propose` and the values it prints; to leave, `buzz org ragequit --dao <dao> --token <each treasury
     token>`.
   - A passkey-account holder: for the days they need to act, replace the ban with a mute everywhere
     (`buzz moderation unban --pubkey <hex>`, then `buzz moderation timeout --pubkey <hex> --expires-in <seconds>`), so
     they can read and act in the app but not post; ban again after. Tell them the window in advance.
6. **Write it in the pilot report**: who, why, which records were sent, and what they did with them.

## The hand test that accepts the fallback

Run on a local server (`scripts/web-invite-only-e2e.sh`'s setup, or the hosted test server before inviting anyone) with
a contributor project that has one claim under review and one award vote open, and two holders: **A** with a browser
wallet, **B** with a passkey account.

1. **Mute everywhere B.** B reloads: the project, its Work tab and the evidence open; voting on the award works; a post
   is refused with a message saying they are muted. *Working:* every read and the vote succeed, only the post fails.
2. **Ban A.** A reloads: the banned notice, and no project page. *Working:* that, and nothing that reads like a broken
   server.
3. **Steps 3 to 5 above for A.** The copy's hash matches the chain; A's `vote` and `work state` succeed from the command
   line; A's `ragequit` with a small amount succeeds and A's Shares go down. *Working:* A voted and left without the
   server.
4. **Ban B, then step 5's swap for B.** B votes and opens Funds' "Leave and take my share" preview in the app while
   muted; after the ban is restored B is turned away again. *Working:* B acted inside the window, and nowhere else did
   their access change.
5. **Nothing leaked.** Signed in as a third member who holds nothing in that project, and signed out: the evidence sent
   to A is not visible anywhere it was not before.

As of 2026-11-01, steps 1 to 3 for a browser-wallet holder run in the pilot gate ("Automated" below; passed on a
local server and dev chain that day). The copy-and-hash part of step 3, step 4 and step 5 need a server and a person per
role and have not been run. Until all five pass by hand, the restriction-of-holders gap stays open in
[STATUS.md](STATUS.md).

## Automated (2026-11-01)

`scripts/web-restricted-holder-e2e.sh` (in the pilot set of `scripts/mvp-gate.sh`) runs
`web/tests/e2e-real/restricted-holder.spec.ts` on a real server serving the pilot build and a dev chain built as
`cli-no-raise-e2e` builds it: a project the holder (a browser-wallet account with Shares) is in, with an award vote and a
second decision open. The founder publishes the project in a community of their own, and a contributor submits work from
the page, so its evidence is on the server. Then:

- **Mute everywhere** (kind 9042 from the community's owner): the holder opens the project's Work tab and reads that
  evidence, and votes for the award in the page; a post on Home is refused with "You are muted everywhere in this
  community". This is hand-test step 1, for a browser-wallet holder.
- **Ban** (kind 9040): the community shows the holder the banned notice and the server refuses their writes; the command
  line, given the banned person's own Nostr key and the server's address as well as their wallet's key, reads the claim
  with `buzz launchpad work state`, votes on the second decision (a new work area) with `buzz launchpad vote` (the
  decision's tally rises by the holder's Shares), and `buzz org ragequit --dao <dao> --shares <half> --token <dev USDC>`
  takes half their Shares out of the DAO (their Shares go down by that much and their part of the treasury's dev USDC
  arrives). **Known failure (2026-11-01):** that last step fails today: `buzz org ragequit` sends with the
  shared 300,000 gas cap, and a ragequit of one treasury token on a kit-built DAO needs about 336,000, so the command
  stops with "gas estimate ... exceeds the 300000 cap" and nothing is sent. The journey stays red until the command
  sets its own cap (`crates/buzz-cli/src/commands/org_ragequit.rs`); until then a banned holder leaves with `cast send`
  as in `cli-milestone-e2e`. The ban is still in force afterwards. These are hand-test steps 2 and 3, apart from copying the evidence
  to the holder and checking its hash.

Still by hand: the copy-and-hash part of step 3, step 4 (a passkey-account holder, whose fallback is lifting the ban to
a mute while they act) and step 5 (nothing leaked).
