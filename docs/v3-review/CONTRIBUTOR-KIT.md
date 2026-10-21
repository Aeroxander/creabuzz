# The contributor kit: a contributor project ready for work on day one (contract change, D66, 2026-10-19)

Written before the code, as the plan's rule asks of any contract change.

## The gap

A contributor project made by the DAO maker (`OrgBinding.summonAndBind`, D65) is born with nothing to work on. Before
anyone can claim work, it needs:

- a work budget, which takes the full vote (48 h review with the 12 h hold inside it, then a 1 day wait: about 3 days);
- then a project inside it, on the lighter vote (24 h with the 6 h hold inside it, then 1 day: about 2 days).

So the first claim is possible about **five days** after the founder pressed Start. During those days the founder is the
only holder, so the votes protect nobody: no one can be outvoted, and no one is there to object or leave. The waits
cost the founder a week and protect nothing.

The DAO maker cannot do better, because it fixes its own setup calls (on purpose: it takes no arbitrary calls). The
lane timings are themselves set by a vote. So there is no way around it without a contract.

## The change

One new contract, `contracts/src/ContributorKit.sol`, beside the existing kit. No existing contract changes.

`ContributorKit.launch(params)` makes, in one transaction, a DAO through the same patched factory (`Summoner`) the
launch kit uses, with **the caller as its only holder** and these setup calls, which run as the DAO while it is born:

1. `setProposalThreshold(1% of the starting Shares)`. The factory's defaults already give a 14-day decision lifetime
   and a 1-day wait.
2. `factory.create(...)`: the first work budget, **Shares only** (no money in it, no reviewer bond), with the reviewers
   and how many must agree.
3. `approveProject(...)` on that budget, optional: the first project, with its manager, its Shares and its "what done
   looks like" check.
4. `setTransfersLocked(true, true)`: Shares (and the unused Loot) cannot be sent between wallets, except to and from the
   DAO. Awards still mint and leaving still burns: the lock touches neither. This is Recommendation 1 of
   [CONTRIBUTOR-TOKEN-TRADING.md](CONTRIBUTOR-TOKEN-TRADING.md), now done at birth. A later vote can lift it.

Afterwards the kit **reads everything back** and reverts the whole transaction unless:

- the threshold, the 14-day lifetime and the 1-day wait are what was asked, and the DAO's voting policy is its own;
- the work budget is at the address it was predicted at and belongs to this DAO;
- the first project, if one was asked for, exists with that manager;
- both tokens are locked.

**The one tricky part: the budget's address.** The budget factory makes each budget with a plain `CREATE`, so its
address depends on how many budgets the factory has made, which a contract cannot read. The app reads that count just
before sending, and passes the predicted address. If another budget is made first in the same block, the read-back
fails and the transaction reverts: nothing is made and the founder presses again. That costs gas on a busy network, but
it never creates a half-made project.

**Making it once.** The DAO address comes from the caller and a salt the app derives from the project, so it is known
before sending. A second send for the same project reverts (the address is taken), and a reload checks for code there
instead of sending again. Scoping the salt to the caller means nobody else can take the address first.

## What does not change

- Every later decision is voted as before: more budgets, more projects, every **award** (lighter vote, about 2 days),
  lifting the transfer lock, anything touching the treasury. Once anyone besides the founder holds Shares, the waits
  protect them again.
- The DAO is the same kind as every other here (the same factory, voting policy and budget factory), so the Decisions,
  Work, Track record and Contributions tabs read it unchanged.
- No sale is set, so nothing can be bought from it.
- `OrgBinding` stays for its other use (binding a community's org to a DAO). The web contributor path stops using it.

## Tests

Forge (`contracts/test/ContributorKit.t.sol`), against the real factory, budget factory and policy:

- a launch gives a DAO with the founder's Shares, the threshold, a locked token, a Shares-only budget with the panel,
  and the first project with its manager. A contributor can then file a claim that the manager binds, with no vote;
- a transfer between wallets reverts, while an award still mints;
- a wrong predicted budget address reverts the whole launch;
- the same caller and salt cannot launch twice; another caller with the same salt gets a different DAO;
- bad terms revert (no reviewers, a quorum above the panel, a project larger than the per-project limit).

Web: the unit tests and the real-chain journey move to the kit, and the journey files a claim right after Start, with
no budget or project vote.

## Audit scope

It adds one small contract to the contributor-project audit scope. It holds nothing and keeps no roles after the
transaction. Mainnet stays off.

## On Sepolia (D83, 2026-10-21)

`scripts/sepolia-deploy.sh` deploys the kit with the summoner and the launch kit; it is not broadcast yet. The real-chain
journey runs on a fork of Sepolia with `scripts/web-contributor-e2e.sh --sepolia-fork`, and both runs first ask the kit
itself to refuse the D79 limits. The hosted build's settings are in `docs/sepolia-testnet.md` §3. Shares earned on Sepolia
are test records: they will not move to a real network automatically, and the app says so where people start a project
and where they see who earned what.
