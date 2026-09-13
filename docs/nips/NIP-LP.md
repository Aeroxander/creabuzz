NIP-LP
======

DAO Launchpad

`draft` `optional` `relay`

**Depends on**: NIP-01 (basic event format, addressable events), NIP-09 (event
deletion), NIP-34 (git repositories, issues). Interacts with NIP-29 (the
channels a launch binds to), NIP-MP (projects a launch references), and
NIP-OA (how agents inherit owner authority).

## Abstract

This NIP defines five Buzz-specific event kinds (`37001`, `47002`–`47005`) for DAO
launches: one addressable **launch record** holding the launch's identity,
community link, chain addresses, and auction parameters; plus four regular
kinds for **bid mirrors**, **founder updates**, **proposal records**, and
**chain-state receipts**.

The chain is the ledger; Nostr is the record. Capital, escrow, minting, and
conversion happen onchain (provable, slashable, irreversible). Framing,
discussion, updates, and receipts are Nostr events (cheap, searchable,
human- and agent-readable). Hash links bind the two. Receipt and bid-mirror
events are advisory: the chain is authoritative and clients verify against
it when money is at stake.

## Motivation

A DAO launch needs a coordination surface (who is raising, on what terms, in
which community, with what progress) and a money surface (auction, token,
treasury, governance). Buzz already owns the coordination surface. These
kinds give launches a first-class, signed, searchable record inside the
community that spawned them, without inventing a new HTTP API: realtime
fan-out, NIP-29 scoping, and the existing auth pipeline come for free.

One custom record kind is required because no standard kind expresses
"a fundraise with a community link, chain addresses, and an auction
parameter commitment under one signer." Everything else reuses standard
semantics (regular events, `a`/`e`/`p`/`d` tags, NIP-09 deletion).

## The kinds

| Kind | Name | Shape | Author | Purpose |
|------|------|-------|--------|---------|
| `37001` | Launch record | parameterized replaceable, `d` = launch id | founder key | identity, community link, chain addrs, auction params, stage |
| `47002` | Bid mirror | regular, `a` = launch coordinate | bidder (or indexer) | auction bid: bucket, budget, max price, tx hash |
| `47003` | Launch update | regular, `a` = launch coordinate | founder key | signed update: title + markdown body + links |
| `47004` | Proposal record | regular, `a` = launch coordinate | founder/member | proposal: onchain id if any, plain vs futarchy, issue link, state |
| `47005` | Receipt | regular, `a` = launch coordinate | anyone (usually indexer bot) | chain-state mirror: table kind, tx hash, payload JSON |

Kinds `37002`–`37009` and `47006`–`47009` are reserved for future launchpad use.

## `37001`: the launch record

Tags:

- `["d", <launch-id>]` — stable id, REQUIRED, exactly one. Lowercase
  `[a-z0-9-]` recommended (e.g. `nebula-dao`).
- `["name", <display name>]` — REQUIRED.
- `["buzz-channel", <channel-uuid>]` — bound discussion channel. MAY be
  repeated (announcements + discussion). Follows the NIP-34 `buzz-channel`
  convention.
- `["a", "30621:<owner-hex>:<project>", ...]` — linked NIP-MP projects.
  A launch asserts grouping only; it gains no authority over member
  repositories (same rule as NIP-MP).
- `["team", <hex-pubkey>, <role>]` — founders/team. `role` is a free string
  (`founder`, `engineer`, ...). Clients resolve seed weights offchain; the
  chain never reads this tag.
- `["chain", <chain-id>]` — e.g. `11155111`. Exactly one for v1.
- `["auction", <0x-address>]`, `["token", <0x-address>]`,
  `["treasury", <0x-address>]`, `["hook", <0x-address>, <bucket>]` — chain
  addresses. Absent = not yet deployed (pre-launch launches).
- `["admission", "curated" | "community"]` — sale admission track.
- `["t", "dao-launchpad"]` — discovery marker. Clients SHOULD include it;
  directory queries filter on it.

Content is JSON:

```json
{
  "pitch": "One-paragraph pitch.",
  "stage": "draft | review | live | funding | graduated | failed",
  "currency": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "floorPrice": "1000000",
  "tickSpacing": "100",
  "requiredRaised": "50000000000",
  "graduationThreshold": "50000000000",
  "budget": "4166666666",
  "startBlock": 12345678,
  "endBlock": 12395678,
  "claimBlock": 12400678,
  "paramsHash": "0x…",
  "website": "https://…",
  "docs": ["<blossom-or-https-url>"]
}
```

`budget` (optional) is the monthly operating budget in currency smallest
units, a commitment investors price at bid time: a budget above a sixth of the
graduation threshold is displayed as a warning by clients (the treasury could
be refilled only about every six months at the cap). It is a commitment, not a
chain-enforced number.

`paramsHash` commits to the full offchain auction configuration (steps,
buckets, caps, gating) so clients can detect silent edits. `stage` is a
display hint; the chain determines the truth. `tokenPlan` (optional) records
a mint intent — `{mode: "mint", name, symbol, supply}` in whole tokens —
when the founder chose mint-over-import in the wizard; the `token` tag is
added later once the apptoken deploys.

**Authority.** Replaceable only by its signer. The signer SHOULD be the
founder key (or a team key whose members are listed in `team` tags).
Unlinking a community (removing `buzz-channel`) requires an explicit
republish; discussion history in the old channel is retained, never moved.

## `47002`: bid mirrors

A bidder (or an indexer watching the auction contract) publishes one event
per bid: `a` = launch coordinate (`37001:<author-hex>:<launch-id>`),
`m` = bucket id, content JSON
`{"budget": "<uint-string>", "maxPrice": "<uint-string>", "tx": "<0x-hash>"}`.
Mirrors exist for feed, search, and notifications. Fills, refunds, and
claims are chain truth; mirrors MUST NOT be treated as settlement.

## `47003`: launch updates

Founder-signed. `a` = launch coordinate. Content JSON
`{"title": "…", "body": "markdown…", "links": ["…"]}`. Clients render an
Updates feed and MAY cross-post the title into a bound channel as a regular
message (one user action = one atomic persist: the update event and the
channel message are published together or not at all).

## `47004`: proposal records

`a` = launch coordinate. Content JSON
`{"proposalId": "<onchain-id-or-null>", "kind": "plain | futarchy-budget | signal", "issue": "<1621-coordinate-or-null>", "state": "open | passed | executed | defeated", "title": "…"}`.
Proposals with no onchain action (`signal`) live as git issues (NIP-34
`kind:1621`) and are only mirrored here for launch-scoped discovery.
Futarchy markets exist only for `futarchy-budget` (budget/subDAO
allocation); all other proposals are plain votes.

## `47005`: receipts

Anyone MAY publish; usually an indexer bot. `a` = launch coordinate,
`tx` = chain tx hash, `kind` = one of
`auction-created | bid | sweep | claim | lock | summon | stream | cancel | ragequit`.
Content is the mirrored payload JSON. Advisory: clients MUST cross-check
the chain before acting on money.

## Deletion

NIP-09 `kind:5` tombstones apply. Launch records address deletion by `a`
coordinate (`37001:<author-hex>:<launch-id>`), like NIP-MP projects.
Deleting a launch record hides the directory card; it changes nothing
onchain.

## Relay notes

Launchpad events are stack-scoped via `a` tags, not channel-scoped via `h`
tags. Directory queries use `kinds:[37001]` with `#t:[dao-launchpad]`.
Per-launch queries use `kinds:[37001,47002..47005]` with `#a:[coordinate]` and/or
`#d:[launch-id]`. Relay filters MUST always specify `kinds` (p-gate).

## Non-goals

This NIP does not define the auction mechanism, token standard, vesting
locks, or governance rules — those live in the contract layer. It does not
grant the launch signer any authority over linked projects, repositories,
or channels. It does not define nested launches.
