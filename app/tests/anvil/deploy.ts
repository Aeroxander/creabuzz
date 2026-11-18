/**
 * The platform on anvil, deployed from the existing build (`contracts/next/out`, no compile) in the order of
 * `contracts/next/script/DeployPlatform.s.sol` and `test/helpers/Platform.sol`: Permit2 at its canonical address,
 * Uniswap's pool manager, position manager and test swap router, then the dollar token, fee controller, auction factory,
 * the strategy and pool guard at mined addresses (through the CREATE2 deployer, as the script does), the bid rules, the
 * parts and the Launcher. No test double stands in for any of it.
 */
import {
  encodeFunctionData,
  encodeParameters,
  keccak256Hex,
  PERMIT2_ADDRESS,
} from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import { creationCode, deploy, rpc, send } from "./rpc";

/** The CREATE2 deployer anvil has at genesis (the same on every network). */
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
/** The low 14 bits of a hook's address name its hooks; the strategy and the guard need exactly `beforeInitialize`. */
const HOOK_MASK = (1n << 14n) - 1n;
const BEFORE_INITIALIZE = 1n << 13n;

export interface Platform {
  quote: string;
  launcher: string;
  poolManager: string;
  positionManager: string;
  swapTest: string;
  strategy: string;
  guard: string;
  minBid: string;
  platform: string;
  stake: string;
}

/** The first salt whose CREATE2 address has exactly the `beforeInitialize` bit among the hook bits (bounded). */
export function mineSalt(initCode: string): { salt: string; address: string } {
  const hash = keccak256Hex(initCode).slice(2);
  for (let i = 0; i < 1_000_000; i += 1) {
    const salt = i.toString(16).padStart(64, "0");
    const address = `0x${keccak256Hex(`ff${CREATE2_DEPLOYER.slice(2)}${salt}${hash}`).slice(-40)}`;
    if ((BigInt(address) & HOOK_MASK) === BEFORE_INITIALIZE)
      return { salt: `0x${salt}`, address };
  }
  throw new Error("no salt found");
}

async function create2(from: string, initCode: string): Promise<string> {
  const { salt, address } = mineSalt(initCode);
  await send(from, CREATE2_DEPLOYER, `${salt}${initCode.slice(2)}`);
  const code = await rpc<string>("eth_getCode", [address, "latest"]);
  if (code === "0x") throw new Error("create2 left no code");
  return address;
}

export async function deployPlatform(
  admin: string,
  stake: string,
): Promise<Platform> {
  // Permit2 at its canonical address: deploy it, then copy its runtime there (scripts/dev-chain.sh does the same).
  const permit2 = await deploy(admin, "Permit2.sol/Permit2.json");
  const runtime = await rpc<string>("eth_getCode", [permit2, "latest"]);
  await rpc("anvil_setCode", [PERMIT2_ADDRESS, runtime]);

  const poolManager = await deploy(
    admin,
    "PoolManager.sol/PoolManager.json",
    ["address"],
    [admin],
  );
  const zero = `0x${"0".repeat(40)}`;
  const positionManager = await deploy(
    admin,
    "PositionManager.sol/PositionManager.json",
    ["address", "address", "uint256", "address", "address"],
    [poolManager, PERMIT2_ADDRESS, 300_000n, zero, zero],
  );
  const swapTest = await deploy(
    admin,
    "PoolSwapTest.sol/PoolSwapTest.json",
    ["address"],
    [poolManager],
  );
  const quote = await deploy(admin, "QuoteToken.sol/QuoteToken.json");
  const feeController = await deploy(
    admin,
    "FixedFeeController.sol/FixedFeeController.json",
    ["address", "uint24"],
    [admin, 30_000n],
  );
  const factory = await deploy(
    admin,
    "ContinuousClearingAuctionFactory.sol/ContinuousClearingAuctionFactory.json",
    ["address"],
    [feeController],
  );
  const strategy = await create2(
    admin,
    creationCode("LBPStrategy.sol/LBPStrategy.json") +
      encodeParameters(
        ["address", "address", "address"],
        [positionManager, poolManager, factory],
      ).slice(2),
  );
  const guard = await create2(
    admin,
    creationCode("PoolGuard.sol/PoolGuard.json") +
      encodeParameters(["address", "address"], [poolManager, strategy]).slice(
        2,
      ),
  );
  const minBid = await deploy(
    admin,
    "MinBid.sol/MinBid.json",
    ["uint128", "uint256", "uint64"],
    [1_000_000n, 4n, 720n],
  );
  const parts = await deploy(admin, "Parts.sol/Parts.json");
  const launcher = await deploy(
    admin,
    "Launcher.sol/Launcher.json",
    [
      "address",
      {
        tuple: [
          "address",
          "address",
          "address",
          "uint16",
          "uint16",
          "uint16",
          "uint16",
          "uint128",
          "uint128",
        ],
      },
      "address",
      "address",
      "address",
      "address",
      "address",
    ],
    [
      admin,
      [
        quote,
        admin,
        stake,
        500n,
        100n,
        15n,
        60n,
        25_000_000n,
        1_000_000n * 10n ** 18n,
      ],
      strategy,
      guard,
      minBid,
      parts,
      zero,
    ],
  );
  return {
    quote,
    launcher,
    poolManager,
    positionManager,
    swapTest,
    strategy,
    guard,
    minBid,
    platform: admin,
    stake,
  };
}

/** Mint play dollars to `to` (the test token lets anyone mint). */
export async function mintDollars(
  from: string,
  quote: string,
  to: string,
  amount: bigint,
) {
  await send(
    from,
    quote,
    encodeFunctionData(
      "mint(address,uint256)",
      ["address", "uint256"],
      [to, amount],
    ),
  );
}
