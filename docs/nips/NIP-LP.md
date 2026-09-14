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
| `37006` | Score root | parameterized replaceable, `d` = `<program>:<epoch>` | scoring operator | trustgraph score Merkle root + proof pointer |

Kinds `37002`–`37009` (except `37006`) and `47006`–`47009` are reserved for future launchpad use.

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
  "longPitch": "What exists today, why now, what failure looks like.",
  "ipList": ["https://github.com/…", "naddr1…"],
  "updateCadence": "monthly with KPIs",

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

`longPitch` (optional), `ipList` (optional, URLs or NIP-MP `a` coordinates)
and `updateCadence` (optional) are the founder commitments. Clients gate the
`review` → `live` stage on them: numeric terms make a deployable auction;
these make an investor able to judge the person running it. A launch cannot
leave `review` without a long pitch, a bound `buzz-channel`, a committed
`budget`, and an update cadence.

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

### `37006`: score-root record

An operator publishes the proven Merkle root of a community's scores once per
epoch: `{program, root, epoch, indexerUrl?, anchorBlock?}`. The `root` is the
same root `TrustGatedHook` consumes for gate gating; clients verify an
individual score claim against it with a sorted-pair Merkle proof and the
leaf `keccak256(abi.encode(member, score))` — no prover needed on the read
side. The workspace data the root was computed from stays private; the root
proves the computation, never exposes the source. Malformed roots (wrong
length, missing program) are refused by clients rather than shown as
authoritative.


## Graduation execution (apptoken rails)

Decision (§7.2, 2026-09-13): the launch graduates into **apptoken rails**,
not a Uniswap v4 pool. `contracts/src/GraduationExecutor.sol` is deployed as
the auction's `fundsRecipient` AND `tokensRecipient` at launch (the CCA's
sweeps are recipient-only), so one call atomically:

1. `sweepCurrency()` — net raised currency into the executor (protocol fee
   already taken by the immutable fee controller),
2. `sweepUnsoldTokens()` — remaining supply back,
3. split by `reserveBps`: reserve → escrow for the TokenMaster floor,
   remainder → treasury; unsold tokens → treasury,
4. emit `GraduationExecuted` (mirrored as a 47005 `sweep` receipt).

The reserve releases once, treasury-only, to the recorded pool
(`releaseReserve`, mirrored as 47005 `lock`); if the pool never lands the
treasury can `withdrawStuckReserve`. The accounting-only
`AppTokenLBPInitializer` is superseded — do not deploy it for new launches.


## Relaunch, exit, and vesting (A3 / B4 / B5, 2026-09-13)

- **Relaunch keeps the record id.** A failed launch is republished under the
  same `d` with `stage` reset and chain links cleared: the community and its
  history stay (the paper's "problems outlive teams" on the record layer).
  The refund for the failed raise is the auction contract itself.
- **Exit proposal.** A `47004` proposal with `kind: "return-capital"` is the
  visible exit path: a signal on Nostr before graduation (the onchain refund
  is the auction's `exitBid`), a real DAO decision after.
- **Performance vesting.** `vesting` on the record: `{cliffBlocks, tranches:
  [{multiple, percent}], twapWindow?}` — tranches unlock at price multiples of
  the raise price (MetaDAO's 2x..32x ladder default; ascending, summing to
  100). The onchain enforcer is deferred (plan §7.4: verifier milestones
  primary, TWAP backstop). Clients refuse to publish a config that sums wrong
  or descends.
- The liquidity minimum is a wizard *policy*, never a record/chain field: the
  wizard converts "20% of the raise" into supply percent (`liquidity >= sale%
  * 2000/10000`) and warns when the pool would be thin.


## Agent seats (C4, 2026-09-13)

Agents are first-class launchpad participants, not impersonators:

- An agent-authored launch/mirror stays authored by the agent key and carries
  a self-describing `["agent", <agent-pubkey>]` tag so clients can badge
  "Agent-run" without decoding signatures. When the owner opts in, the event
  also carries a NIP-OA `auth` tag (owner BIP-340 attestation over
  `nostr:agent-auth:<agent-pubkey>:<conditions>`) — the web app attests when
  an owner identity exists; the CLI respects `BUZZ_AUTH_TAG` on every launchpad
  write. Clients MUST NOT treat an `auth` tag as an identity override
  (NIP-OA).
- Web: the create dialog and bid dialog offer a "as agent" toggle; the
  directory and detail badge the launch.
- CLI: `buzz launchpad compose-bid --as-agent` marks the unsigned envelope
  agent-authored (the mirror, when recorded under `BUZZ_AUTH_TAG`, carries the
  attestation).


## Decisions applicable to this NIP (2026-09-13)

- Agents publish launchpad records/mirrors under their own key with NIP-OA
  attestation (C4). They never sign onchain value movement — an agent is
  publish-only by policy.
- The "participation token" concept is retired: the instruments with defined
  claims (sale tokens, Moloch shares/loot, apptoken rails) are the answer to
  the paper's undefined record-of-participation. No 47006 ledger.
- Each project owns its legal posture; the NIP adds no admission restriction
  beyond what the launch's own hooks configure.
