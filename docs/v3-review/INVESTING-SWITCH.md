# The investing switch

One page for whoever runs the site. Investing is **one switch, off by default**. Contract design is in
[BACKING-POOL.md](BACKING-POOL.md); the direction it must fit (the record first, money second) is in
[DIRECTION.md](DIRECTION.md).

## What the switch is

`VITE_INVESTING=1` in `deploy/compose/.env`, with three addresses for the network the page reads:

| Setting | Holds |
|---|---|
| `VITE_BACKING_POOL_FACTORY` | the pool factory, `{"11155111":"0x..."}` |
| `VITE_CONTRIBUTOR_KIT_V3` | the kit that makes a project with its pool, same shape |
| `VITE_BACKING_QUOTE_TOKEN` | the token backers pay in (the one the factory was deployed with) |

It also needs what any chain read needs: `VITE_LAUNCHPAD_CHAIN_ID`, `VITE_CHAIN_RPC_URL` and `VITE_HISTORY_FROM_BLOCKS`. If the
backers pay in the free test token, `VITE_TEST_QUOTE_TOKENS` adds a "Get test tokens" button.

A ready block for Sepolia is in `deploy/compose/.env.creaton.example`. `./run.sh build` runs the settings check first and
stops with one plain message when the switch is on and an address, the chain node or the history block is missing, when an
address is named without the switch, or when the switch is anything but `1`.

## What it turns on

- A **Backing** block on a project's page and its public scorecard: how backing stands, what is held for the project, what
  was released, the next milestone and the date backers may leave by. No price or returns there.
- Actions for a signed-in person: back a project, sell, leave at a milestone, take part in the opening round, collect.
  For a founder: open backing, post a milestone. For anyone: settle a round or a milestone once its time has come.
- **Leaving keeps your units.** At a milestone a backer can stay or leave. Leaving gives back the money held for the project
  for that backer, less a small fee (never more than staying one more step would cost). The backer keeps their units and can
  still sell them, but no money is held behind them any more, so they get none back if the project is closed for good. The
  form shows the pool's own quote (what you get, and the fee) and sends a limit made from it, never zero. Before the person
  presses Leave the form also says that selling the kept units later is a separate step with its own fee, so leaving and
  then selling pays a fee twice (about 1.8% of the amount in all at the first milestone; the form states no rate). The
  page does not work the fee out and does not describe any return.
- **The curve's depth.** A founder opening backing picks how deep the curve is from the factory's six choices, 10,000 to
  500,000 (the usual one, 25,000, is preselected), with one sentence of help: a deeper curve moves the price less when
  people buy or leave, so pick one about twice the amount hoped for. The Start page's one-step launch uses the usual depth.
  No price is shown for it. There is no 5,000 choice: it was dropped on 2026-11-15, because the shallowest depth is where
  the least money multiplies the price the most, which rewards being first ([BACKING-POOL.md](BACKING-POOL.md), "What the
  first buyers hold"). A factory deployed before that date still answers seven choices and the app refuses to read its
  list: the form then says the choices could not be read and opens at the usual depth. Redeploy before turning the switch
  on.
- Backing cards in **Home's feed** only (the one place a price line appears), always below updates and promises.
- Your positions under **You** and in Home's next step.
- Projects set up from the Start page are made by the V3 kit, so they have a pool at birth. A project made earlier by the
  V2 kit can still open backing with one step by its founder.

The contributor-only image shows all of this when the switch is on, and nothing else that image hides: raises, the weekly
sale and the rest stay hidden. With the switch off, no page changes in any build.

## What it does not do

- It does not turn trading on: that is `VITE_TRADING_TRIAL` and the market factory. The two are independent.
- It does not deploy anything, pay anyone, or change a contract. Pools are as BACKING-POOL.md describes them: no owner, no
  upgrade, terms fixed in the factory.
- It does not make the page safe to use with real money. The contracts have no outside audit and counsel's questions in
  BACKING-POOL.md are open: use test networks only. Mainnet stays off (`VITE_ENABLE_MAINNET`).

## Steps after the contracts are deployed

1. Run `forge script script/DeployBackingSepolia.s.sol --broadcast` (Sepolia, a testnet-only key in `PRIVATE_KEY`). It writes
   `contracts/deployments/backing-sepolia-11155111.json`.
2. From that file take the roles `backing-pool-factory`, `contributor-kit-v3` and `backing-quote-token`, and its `block`.
3. Put the four lines in `deploy/compose/.env` (the block in `.env.creaton.example`). Keep `VITE_HISTORY_FROM_BLOCKS` at the
   earliest block the page reads, which is the older kit's, not this deploy's.
4. `./run.sh build`, then `./run.sh restart`. The build prints `Investing: on (...)`.
5. Open a project made by the new kit, or press "Open backing" as the founder of one made earlier, and press the switch's
   one test: back it with a small amount, sell, and check Home's feed.

To turn it off, remove the four lines and build again: nothing is left on any page.

## Checking a build

- `./run.sh build` prints `Investing: on (...)` or `Investing: off` before the long build.
- `scripts/web-investing-mock-e2e.sh` builds the app twice (switch on, and every address named with the switch unset) and runs
  `web/tests/e2e/investing.spec.ts` against a stand-in chain node: every state of the Backing block, the steps it sends, Home's
  feed, "Projects you back", the depth picker and the leave that keeps units, and that the switch alone turns the page on.
- `scripts/web-backing-e2e.sh` runs the same pages against the real contracts on a local chain (buy, sell, a milestone, leaving
  with the units kept and the pool's own fee, settling it, and an opening round bid and exchange). It needs the compiled
  contracts of the current checkout: after a contract change run it again.
