# Milestone 1: facts about the vendored Uniswap code

Written 16 November 2026 for `docs/NEXT-VERSION-PLAN.md` section 8, row 1. Everything marked **(code)** was read in the
vendored sources under `contracts/lib/continuous-clearing-auction` (the auction, "CCA", tag v2.1.0) and its nested
`lib/liquidity-launcher` (tag v3.0.0), with file and line. **(chain)** = asked a real Sepolia node with `cast`.
**(ran)** = shown by a test in `contracts/next/test`. **(outside)** = my own memory of other products, not checked here.
Nothing in this file is a guess unless it says so.

## 1. What is really vendored

| Piece | Present | Where | Notes |
|---|---|---|---|
| Uniswap v4 `PoolManager` | yes | `liquidity-launcher/lib/v4-core/src/PoolManager.sol` | licence BUSL-1.1 (code, SPDX line). We never copy or redeploy it for real; the real one is used |
| Uniswap v4 `PositionManager` | yes | `liquidity-launcher/lib/v4-periphery/src/PositionManager.sol` | constructor `(poolManager, permit2, unsubscribeGasLimit, tokenDescriptor, weth9)` (code, `PositionManager.sol:128-134`) |
| Permit2 | yes | `continuous-clearing-auction/lib/permit2/src/Permit2.sol` | source pinned to exactly solc 0.8.17. The auction takes bids through it (see 3) |
| `LBPStrategy` (the "strategy") | yes, **one contract, no factory** | `liquidity-launcher/src/strategies/lbp/LBPStrategy.sol`, 473 lines | v3.0.0 removed the per-variant strategy factories (`liquidity-launcher/README.md:79`). One strategy per network serves every sale |
| Auction factory | yes | `continuous-clearing-auction/src/ContinuousClearingAuctionFactory.sol`, 75 lines | constructor `(address protocolFeeController)`, immutable |
| `ProtocolFeeController` | yes | `liquidity-launcher/src/periphery/ProtocolFeeController.sol`, 120 lines | owner-set; see 4 |
| `IValidationHook` | yes | `continuous-clearing-auction/src/interfaces/IValidationHook.sol`, 14 lines | one function; see 6 |
| `InitializerHook` | yes | `liquidity-launcher/src/periphery/hooks/InitializerHook.sol`, 56 lines | abstract, base class of the pool-creation guard |
| `LiquidityLauncher` | yes | `liquidity-launcher/src/LiquidityLauncher.sol`, 68 lines | optional front door that pulls tokens and calls the strategy; we do not need it (our Launcher does the same) |
| Fee forwarding / burning recipients | yes | `liquidity-launcher/src/periphery/{PositionFeesForwarder,BuybackAndBurnPositionRecipient,TimelockedPositionRecipient}.sol` | not what the plan wants (see 5) |
| A swap router (UniversalRouter etc.) | **not vendored** | only on chain | see section 8 below |
| `HookMiner` | yes | `v4-periphery/src/utils/HookMiner.sol` | finds a CREATE2 salt for an address with chosen low bits |

## 2. Exact shapes

**Strategy constructor** `LBPStrategy(IPositionManager, IPoolManager, IDistributorFactory initializerFactory)` (code `LBPStrategy.sol:54`).
It inherits `SelfInitializerMixin` whose constructor requires the strategy's own address to carry exactly the
`beforeInitialize` hook bit (`SelfInitializerMixin.sol:13-16`, `Hooks.validateHookPermissions`). So the strategy must be
deployed at a **searched address** (CREATE2 salt; low 14 bits equal `0x2000`). One in 16,384 salts qualifies (**ran**:
the mined salt is asserted in the tests). That is the "strategy at a searched address" of the plan. The strategy is
also a hook itself, used only as a fallback (see 7).

**Opening a sale** is one call, `strategy.initializeDistribution(token, totalSupply, configData, salt)` (`LBPStrategy.sol:65`). The
caller must have approved the strategy for `totalSupply` tokens. `configData = abi.encode(MigratorParameters,
bytes auctionParams)` where `auctionParams = abi.encode(AuctionParameters)`:

```
MigratorParameters {
  address token;                 // must equal the call's token and the auction's token
  address currency;              // must equal the auction's currency (0 = ETH)
  uint64  migrationBlock;        // pool step allowed from this block; must be greater than the auction's endBlock
  uint128 reservedTokenAmountForLP; // tokens the strategy keeps back for the pool (1..int128.max), < totalSupply
  address recipient;             // gets leftover currency and unused reserve tokens after the pool step
  address positionRecipient;     // owner of the pool position NFTs (not 0, 1, 2)
  PoolParameters { uint24 fee; int24 tickSpacing; address hook; }
  bytes   positionDefinitions;   // abi PositionDefinition[] (0..10 extra ranges); empty = one full-range position
  bytes   lpAllocationSchedule;  // abi LiquidityAllocationBracket[] (1..32): share of raised currency that goes to the pool
}
AuctionParameters {
  address currency; address tokensRecipient; address fundsRecipient;
  uint64 startBlock; uint64 endBlock; uint64 claimBlock;
  uint256 tickSpacing /* Q96 price grid */; address validationHook; uint256 floorPrice /* Q96 */;
  uint128 requiredCurrencyRaised /* the minimum */; bytes auctionStepsData /* packed (mps:24, blocks:40) */;
}
```
(code: `MigratorParams.sol:16-52`, `IContinuousClearingAuction.sol:18-30`.) The strategy splits `totalSupply` into the
auction's share (`totalSupply - reservedTokenAmountForLP`, sent to the auction) and the reserve (kept in the strategy)
(`LBPStrategy.sol:87`, then the two transfers below it). It then asks our auction factory to build the auction;
the strategy's salt is `keccak256(abi.encode(salt, migrationParams))` (`:89-91`) and the factory adds the caller:
`keccak256(abi.encode(msg.sender, salt))` (`ContinuousClearingAuctionFactory.sol:39`). The strategy refuses unless: the auction's `fundsRecipient` **is the
strategy**, its `tokensRecipient` **is not** the strategy, `endBlock < migrationBlock` (`LBPStrategy.sol:369-377`).

**Price units.** Auction prices are Q96 (2^96 = 1) of *currency raw units per token raw unit*. For a 6-decimal dollar
and an 18-decimal Share, 1 dollar per Share is 10^6 / 10^18 = 10^-12 raw, i.e. about 7.9e16 in Q96. Measured limits are in
the report.

**Auction facts used below (code).** Bids go through Permit2 at its fixed address (`ContinuousClearingAuction.sol:479`,
solady `permit2TransferFrom`); the auction's `onTokensReceived()` must have been called by the strategy before bids
(`:119`); a bid at or below the clearing price is refused (`:366`); `MAX_BID_PRICE` is derived from the total
supply (`MaxBidPriceLib.maxBidPrice`, `:84`); a failed sale (not graduated) refunds every bid in full by
`exitBid`/`exitPartiallyFilledBid` (`:499`, `:526`); `checkpoint()`, `exitBid`, `claimTokens` have no owner
check, tokens and refunds always go to the bid's owner (`:604-615`); the two sweeps are recipient-only (`:663`, `:687`).

## 3. Anyone may start the pool step, once

`strategy.migrate(initializer)` (`LBPStrategy.sol:212`) has no caller check, needs `block >= migrationBlock`, and clears the pool
reservation **before** trying (`:239`), so a second call reverts `InitializerNotRegistered`. Inside, the real work is
`try this.tryMigrate(...)`; any revert is caught (`:252`): the strategy then sweeps the currency, sends the reserve tokens
to `recipient`, and emits `FundsRecovered` and `MigrationFailed`. **The transaction succeeds.** That is the swallowed
failure the plan describes. Reproduced in test 5.

## 4. The fee: what the plan said and what the code does

* The auction takes the fee itself: `sweepCurrency()` computes `fee = controller.getProtocolFeeAmount(currency,
  currencyRaised)`, clamps it to the amount raised, sends `currencyRaised - fee` to the funds recipient and `fee` to
  `controller.protocolFeeRecipient()` (`ContinuousClearingAuction.sol:663-685`, `ProtocolFeeLib.sol`).
  `lbpInitializationParams()` reports the post-fee amount the strategy checks against (`:134-152`).
* The controller is read **at call time**, twice, not frozen when the sale opens (the code says so in comments at
  `:133` and `:662`). A mutable controller could change the rate in the middle of a sale. That is the real reason to use our
  own: the factory holds the controller as an immutable (`ContinuousClearingAuctionFactory.sol:18`) and the auction
  reads it from its own immutable (`AuctionStorage.sol:38`), so a controller with no setters fixes the rate for every
  sale of that factory.
* Plan claim "the vendored controller lets its owner set anything up to 100%": **true**. `setGlobalProtocolFeePips`
  refuses only values above 1,000,000 pips = 100% (`ProtocolFeeController.sol:44`); per-currency brackets are capped
  the same way (`:68`). The auction clamps a fee above the raise to the whole raise (`:679`), so an owner could
  take everything.
* A fee call that reverts is turned into **zero fee** by the library (`ProtocolFeeLib.sol:28-30`, try/catch). Our
  controller must therefore never revert.
* The Uniswap deployments of the auction factory on Sepolia (v2.0.0, v2.1.0) have the zero address as controller
  (**chain**, `cast call ... protocolFeeController()`), i.e. no fee at all. Using Uniswap's factory would give the
  platform nothing; we need our own.

## 5. The split of each 100 raised: what the strategy and auction do, and what we must do

The plan: 3 platform, 22 pool, 15 to the project at once, 60 into the floor paid over 12 months.

| Part | Done by the vendored code? | How |
|---|---|---|
| **3 to the platform** | **Yes, free** | the auction's fee, through our fixed-rate controller, paid to the controller's `protocolFeeRecipient()` at the moment the strategy sweeps (the auction pays it, not the strategy) |
| **22 into the pool** | **Yes, free, approximately** | `lpAllocationSchedule` is a list of brackets of "share of the raised (after fee) that goes to the pool", in 1e-7 units. One bracket `{0, rate}` with `rate = round(22 / 97 * 1e7) = 2,268,041` makes the pool take 22 of every 100 raised, to within 1e-7. The strategy takes the amount from the swept currency (`LBPStrategy.sol:174`, `_calculateCurrencyAmountForLp` at `:388`) |
| **How many Shares go in the pool** | **Partly: fixed by price, not by us** | The pool opens at the auction's final clearing price. A full-range position takes currency and tokens in the ratio of that price, and the **smaller side limits** it. With 22 of 100 and a sale that sells all its Shares, the pool needs `22% of Shares sold` = 88,000,000 of the 400,000,000 sold, **not** 100,000,000. The rest of the reserve comes back to `recipient` (`LBPStrategy.sol:201-205`). The plan's "10 percent paired" is therefore 8.8 percent at 22, or 25 of 100 raised for the full 10 percent (see the report) |
| **Who owns the pool position** | **Yes, free** | the position NFTs are minted straight to `positionRecipient` (`PositionPlanner.toPlan`, `:242`, `MINT_POSITION` recipient). The strategy never owns them. Our `LiquidityHolder` is that address. `PositionFeesForwarder` exists but has an operator that can approve a transfer of the position after a timelock (`TimelockedPositionRecipient.sol`), which is not the plan's "nobody" |
| **Where leftover currency goes** | **Yes, free** | everything the position did not take (the other 75 of 100 plus rounding dust) is sent to `recipient` in one transfer (`LBPStrategy.sol:201`, `_transferCurrency`) |
| **Where leftover Shares go** | **Yes, free** | the unused part of the reserve plus dust is sent to `recipient` (`:202-205`). **Unsold sale Shares** are not sent by the strategy: the auction sends them to `tokensRecipient` **only when `tokensRecipient` itself calls `sweepUnsoldTokens()`** (`:687-698`) |
| **15 at once / 60 into a floor over 12 months** | **No** | the strategy puts the whole leftover (about 75) in one address. Our `Treasury` must split what it receives 15 : 60 (20% : 80%) on arrival, keep the 60 as the floor, and pay it out daily |
| **Sweeping unsold Shares** | **No, needs a caller** | our `Treasury` (the `tokensRecipient`) must expose a function anyone can call that calls `auction.sweepUnsoldTokens()` |
| **Anything about the 3% on trades, 1% pool fee split, burning the Shares side, exits** | **No** | pool fee: the position's owner collects it (`DECREASE_LIQUIDITY` by 0), so `LiquidityHolder` does the platform/project split and the burn |
| **Failure of the pool step** | **Hidden** | caught, success status, funds returned to `recipient` (see 3). Our "finish" must read the outcome |

Reading the amount that arrived: the strategy emits `CurrencySwept(recipient, amount)` and `TokensSwept(recipient,
amount)` (`ILBPStrategy.sol`), and the auction reports `currencyRaised()`. Because a stranger can send currency to the
`Treasury`, the safe rule is "new money = balance minus the buckets" and the split is applied to that.

## 6. How the auction calls a bid hook

`_submitBid` calls `VALIDATION_HOOK.handleValidate(maxPriceQ96, amount, owner, msg.sender, hookData)` inside a
try/catch that re-reverts with `ValidationHookCallFailed(reason)` (`ContinuousClearingAuction.sol:359`,
`ValidationHookLib.sol`). The hook is **not a view** and receives the bid amount in the **currency's raw units** (a
`uint128`). So "no bid under 1 dollar of a 6-decimal quote" is `require(amount >= 1_000_000)`. The hook is
immutable per auction (`VALIDATION_HOOK`). It is called after the checkpoint but before the bid is recorded.
The auction's own minimum is "not zero" (`:473`); for 1 raw unit of a 6-decimal dollar that is one millionth of a dollar.

## 7. Pool already exists, and the pool guard

* At open time, `MigratorParams.validateHook` refuses the sale (`InvalidHook`) if the target pool key is **already
  initialised**, even a plain hookless one (`MigratorParams.sol:142-147`). So a stranger who creates the plain pool
  for the project's Share token before the sale opens makes the opening revert. **(ran)**.
* If `poolParameters.hook == address(0)` the strategy initialises the plain pool at pool-step time, and if a plain pool
  appeared meanwhile it falls back to a pool whose hook is the strategy itself (`LBPStrategy.sol:243`). The sale then still works
  but the project's pool is the fallback key and a stranger's plain pool for the same token exists next to it.
* With our `PoolGuard` as `poolParameters.hook` (a subclass of `InitializerHook` whose `authorized` is the strategy,
  mined to a hook address), `beforeInitialize` reverts for everyone except the strategy, so the project's pool key
  can only be created by the strategy. The strategy checks the hook speaks `IInitializerHook`, names the strategy as
  `authorized()`, and carries the `beforeInitialize` bit (`MigratorParams.sol:151-153`).
  The guard does nothing on trades.

## 8. Sepolia: what exists (chain, checked at block 12,146,650 on 16 Nov 2026)

Code size in bytes at the address (`cast codesize`); all answered at that block.

| Piece | Address | Size | Source of the address |
|---|---|---|---|
| v4 PoolManager | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` | 24,009 | `v4-periphery/broadcast/01_PoolManager.s.sol/11155111/run-latest.json`; also `Parameters.sol` of the launcher |
| v4 PositionManager | `0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4` | 23,877 | `v4-periphery/broadcast/DeployPosm.s.sol/11155111/run-latest.json` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9,152 | `Parameters.sol` (`PERMIT2`) |
| UniversalRouter | `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` | 19,540 | **outside** (the task text); exists on chain |
| StateView | `0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c` | 3,531 | v4-periphery broadcast |
| V4Quoter | `0x61b3f2011a92d183c7dbadbda940a7555ccf9227` | 5,820 | v4-periphery broadcast |
| PoolSwapTest (v4's own test swap router) | `0x9b6b46e2c869aa39918db7f52f5557fe577b6eee` | 6,950 | v4-periphery broadcast |
| Auction factory v2.1.0 (Uniswap's, zero fee controller) | `0x000000001F26a0044BaA66024e7b6599c61963F8` | 24,214 | `continuous-clearing-auction/README.md:39` |
| Auction factory v2.0.0 | `0x00cCa200BF124dBfA848937c553864f4B4CE0632` | 24,124 | README |
| LiquidityLauncher v1.0.0 | `0x00000008412db3394C91A5CbD01635c6d140637C` | 3,456 | launcher README |
| CCALens | `0xc3C65F5453A3674aDb693cbdA3C842545cD30f53` | 3,743 | README |
| CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | 69 | launcher `Parameters.sol` |
| **LBPStrategy v3.0.0** | **no canonical deployment is listed anywhere in the vendored docs** | n/a | the v2 strategy factories listed in `DeploymentGuide.md:175-189` are marked deprecated and are a different contract |
| Uniswap's deployed `ProtocolFeeController` | no address listed | n/a | none in the vendored docs |

The compiled size of the vendored auction factory in this project (24,214 bytes, solc 0.8.26, via-IR, optimizer
runs 11,111, no metadata hash) is byte-for-byte the same length as the factory Uniswap deployed on Sepolia
(24,214), a hint, not a proof, that the build settings match theirs. The tests deploy our own factory, strategy and
guard on top of the real PoolManager and PositionManager on the fork.

**The public Sepolia node keeps only the last ~10,000 blocks of history, and state only for the last few dozen blocks**
(**chain**: reading old history gave `pruned history unavailable ... earliest available 12136589` at head 12,146,670;
reading a storage slot of a block about 40 minutes old gave `Archive requests require a personal token`). So a "pinned
block" works from Foundry's local cache (`~/.foundry/cache/rpc`, filled by the first run at that block) or from an archive
node, and from the public node only while the block is fresh. The suite pins `SEPOLIA_PIN = 12,146,937` in
`contracts/next/test/helpers/Stack.sol` and takes `SEPOLIA_FORK_BLOCK` to override it. See `contracts/next/README.md`.

## 9. What the tests showed about the vendored code (ran)

Each line is a test in `contracts/next/test`; the report (`M1-REPORT.md`) has the numbers.

* **The real trade router works.** UniversalRouter at `0x3A9D...F98b` on Sepolia swapped in a pool the strategy created
  on the real pool manager (`UniversalRouter.t.sol`). Commands used: `V4_SWAP` (0x10) with the actions
  `SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, `TAKE_ALL`; payment through Permit2.
* **The real pool manager and position manager accept our strategy and our guard** at mined addresses (`Route.t.sol`,
  `Pieces.t.sol` on the Sepolia copy).
* **A plain pool created first**: before the sale opens, it makes opening revert `InvalidHook(0x0)`; after the sale
  opens, the pool step succeeds and the project's pool is at the strategy's own hook key, next to the stranger's
  (`Attacks.t.sol`). With the guard neither happens.
* **The pool step**: the caller changes nothing (recipients are fixed at open); a second call reverts
  `InitializerNotRegistered`; the inner step is self-call only; 85 gas limits between 0.4 and 12 million either
  revert the whole call or open the pool.
* **A failed pool step** (a dollar token that refuses the position manager as a receiver) is a successful transaction
  with `MigrationFailed` and `FundsRecovered` and without `Migrated`; the same `CurrencySwept` and `TokensSwept` events
  as a success are present; the 97 of every 100 dollars and the whole Share reserve end up with the recipient.
* **A failed sale (below its minimum)** also goes through the pool step as `MigrationFailed` (the reason is
  `NotGraduated`), returns the 100 million reserve, charges no fee, and the auction refunds every bid in full.
* **The fee** is exactly `raised * 30,000 / 1,000,000`, rounded down, paid to the controller's recipient by the auction's
  own sweep.
* **Token order.** In the pool key currency0 is the smaller address; the pool price conversion has a branch for each
  order, and the route passes with the dollar on either side.
* **Permit2 is required at its fixed address** for bids (solady's `permit2TransferFrom`). The local copy builds Permit2
  from source with solc 0.8.17; its bytes differ from Uniswap's deployed Permit2 (different compiler settings), the
  behaviour used (allowance approve and transferFrom) is the same.

## 10. Licences (code, SPDX lines and LICENSE files; not legal advice)

* The auction (`continuous-clearing-auction`, 32 source files checked) and the launcher and strategy
  (`liquidity-launcher`) are **MIT**, as are `PositionManager` and `Permit2`. We deploy the auction factory (which
  builds the auction) and the strategy as they are, so the plan's "licence must be checked first" is answered: MIT, which
  allows it.
* The v4 `PoolManager` is **BUSL-1.1** (`v4-core/licenses/BUSL_LICENSE`). We never copy or redeploy it for real: the
  production route calls Uniswap's own deployment. Our tests compile and deploy a copy of it **in memory** for the local
  twin only; that is a test use and a counsel question if anyone ever wants to ship that copy.
* Our new files (`contracts/next/src`) are written as MIT, matching the code they extend.
* **Audits listed in the vendored docs** (read, not verified): the auction lists OpenZeppelin and Spearbit reports for v2.0.0
  (16 June 2026; we vendor v2.1.0 plus two later commits) and older ones (`docs/audits/README.md`); the launcher lists
  reports up to its **v2.0.0** (OpenZeppelin 23 Jan 2026, Spearbit 21 Jan 2026 and older) (`README.md`, `docs/audit/`).
  The strategy we use is from launcher **v3.0.0**, which merged the old strategy factories into the single `LBPStrategy`
  (CHANGELOG); I found **no audit listed for v3.0.0** in the vendored docs. Ask Uniswap or the auditors whether it is
  covered before any real network. This belongs on the plan's section 9 "off until an outside review" list.
