/**
 * A real local chain for a browser spec: a throwaway anvil on a free port, the pot contracts deployed on it in the order of
 * `contracts/pot/script/DeployPot.s.sol` (so a fresh chain gives the same addresses every time, and the app build that names
 * them works against it), and a project launched through the app's own call builders. The spec file starts one per file
 * and stops it after.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../../packages/creaton-core/src/launchpad/project-chain.ts";
import {
  decodeReturn,
  encodeCall,
} from "../../../../packages/creaton-core/src/pot/abi-codec.ts";
import { LAUNCHER_ABI } from "../../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../../packages/creaton-core/src/pot/pot-calls.ts";
import { readProjectParts } from "../../../../packages/creaton-core/src/pot/pot-state.ts";
import { accounts, call, rpc, pointAtRpc } from "../../anvil/rpc";
import { deployPot, type PotChain, walletOf } from "../../anvil/pot-chain";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const POT_OUT = resolve(
  HERE,
  "../../../../contracts/pot/out/Treasury.sol/Treasury.json",
);
export const ANVIL = process.env.ANVIL ?? "anvil";

/** Why a spec that needs a real chain cannot run here, or null when it can. */
export const NO_CHAIN_WHY: string | null = (() => {
  const probe = spawnSync(ANVIL, ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0)
    return "needs anvil on PATH (or ANVIL=/path/to/anvil)";
  if (!existsSync(POT_OUT))
    return "needs contracts/pot/out built (forge build in contracts/pot)";
  return null;
})();

const freePort = (): Promise<number> =>
  new Promise((ok, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => ok(port));
    });
  });

/** The time unit of the test chain in seconds (28 minutes): the check-in window is two of them, a wind-down 26. A multiple of 168, as the contracts need. */
export const UNIT = 1680;

export interface LiveWorld {
  rpcUrl: string;
  chain: PotChain;
  who: {
    admin: string;
    founder: string;
    backer: string;
    second: string;
    member: string;
    helper: string;
    stranger: string;
  };
  stop(): Promise<void>;
}

/** Use an anvil somebody else started (a script that built the app for its address) and deploy the pot contracts on it. */
export async function attachWorld(
  rpcUrl: string,
  options: { unit?: number } = {},
): Promise<LiveWorld> {
  pointAtRpc(rpcUrl);
  const [admin, founder, backer, second, member, stranger, helper] =
    await accounts();
  const chain = await deployPot(admin, options.unit ?? UNIT);
  return {
    rpcUrl,
    chain,
    who: { admin, founder, backer, second, member, helper, stranger },
    stop: async () => {},
  };
}

/** Start anvil and deploy the pot contracts. Everyone but the admin is given their play dollars at once unless `faucet` says no. */
export async function startWorld(
  options: { unit?: number } = {},
): Promise<LiveWorld> {
  const port = await freePort();
  const state = mkdtempSync(resolve(tmpdir(), "pot-live-"));
  const child: ChildProcess = spawn(
    ANVIL,
    [
      "--port",
      String(port),
      "--chain-id",
      "31337",
      "--gas-limit",
      "100000000",
      "--prune-history",
      "--silent",
      "--cache-path",
      resolve(state, "cache"),
    ],
    { stdio: "ignore" },
  );
  const rpcUrl = `http://127.0.0.1:${port}`;
  pointAtRpc(rpcUrl);
  const stop = async () => {
    child.kill();
    rmSync(state, { recursive: true, force: true });
  };
  try {
    for (let i = 0; ; i += 1) {
      try {
        await rpc("eth_blockNumber");
        break;
      } catch {
        if (i > 80) throw new Error("anvil did not start");
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const [admin, founder, backer, second, member, stranger, helper] =
      await accounts();
    const chain = await deployPot(admin, options.unit ?? UNIT);
    return {
      rpcUrl,
      chain,
      who: { admin, founder, backer, second, member, helper, stranger },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Whether the app build in `dist` names this world's Launcher: a build made for another address would show "money steps are
 * not switched on" and every spec would fail for a reason that is not the app's. Returns a sentence when it does not.
 */
export function buildMismatch(
  world: LiveWorld,
  dist = resolve(HERE, "../../../dist"),
): string | null {
  const folder = resolve(dist, "assets");
  if (!existsSync(folder))
    return `no build in ${dist}: run pnpm build with CREATON_DEPLOYMENTS_FILE set`;
  const want = world.chain.launcher.toLowerCase();
  const found = readdirSync(folder)
    .filter((f) => f.endsWith(".js"))
    .some((f) =>
      readFileSync(resolve(folder, f), "utf8").toLowerCase().includes(want),
    );
  return found
    ? null
    : `the app in ${dist} was not built for the Launcher at ${world.chain.launcher}: build it with CREATON_DEPLOYMENTS_FILE naming a deployments file with that address (a fresh anvil gives the same addresses every time)`;
}

export interface LiveProject {
  label: string;
  /** The project record's address on the server (`37001:<founder>:<label>`). */
  coordinate: string;
  projectId: string;
  key: string;
  treasury: string;
  shares: string;
  team: string;
  vester: string;
  dollar: string;
  launcher: string;
  launchedAt: number;
}

/** The founder's account takes its play dollars and launches `label` with a daily allowance of 0.10% and a Team pool. */
export async function launchProject(
  world: LiveWorld,
  label: string,
  founderNostr: string,
): Promise<LiveProject> {
  const { founder } = world.who;
  const wallet = walletOf(founder);
  if (!(await usedFaucet(world, founder)))
    await wallet.sendCalls([pot.faucetCall(world.chain.dollar)], 31337);
  const read = (to: string, data: string) => call(to, data);
  const [settingsHash] = decodeReturn(
    LAUNCHER_ABI,
    "settingsHash",
    await read(
      world.chain.launcher,
      encodeCall(LAUNCHER_ABI, "settingsHash", []),
    ),
  );
  const coordinate = `37001:${founderNostr}:${label}`;
  const projectId = projectIdOf(coordinate);
  await wallet.sendCalls(
    [
      pot.launchCall({
        launcher: world.chain.launcher,
        projectId,
        name: label,
        symbol: label.slice(0, 4).toUpperCase(),
        ratePpm: 1000,
        teamPool: 10_000_000n * 10n ** 18n,
        settingsHash: settingsHash as string,
      }),
    ],
    31337,
  );
  const key = chainKeyOf(founder, projectId);
  const parts = await readProjectParts(read, world.chain.launcher, key);
  return {
    label,
    coordinate,
    projectId,
    key,
    treasury: parts.treasury,
    shares: parts.shares,
    team: parts.team,
    vester: parts.vester,
    dollar: world.chain.dollar,
    launcher: world.chain.launcher,
    launchedAt: parts.launchedAt,
  };
}

async function usedFaucet(world: LiveWorld, who: string): Promise<boolean> {
  const { faucetUsedBy } = await import(
    "../../../../packages/creaton-core/src/pot/pot-state.ts"
  );
  return faucetUsedBy((to, data) => call(to, data), world.chain.dollar, who);
}

/** Give `who` the faucet's play dollars (the same call the app's faucet sheet sends). */
export async function giveDollars(
  world: LiveWorld,
  who: string,
): Promise<void> {
  if (await usedFaucet(world, who)) return;
  await walletOf(who).sendCalls([pot.faucetCall(world.chain.dollar)], 31337);
}

/** The chain's own clock: the newest block's time, in seconds. */
export async function chainNow(): Promise<number> {
  const block = await rpc<{ timestamp: string }>("eth_getBlockByNumber", [
    "latest",
    false,
  ]);
  return Number.parseInt(block.timestamp, 16);
}

/** `who` backs `project` with `dollars` (whole dollars) through the app's own plan, as the Back sheet does; gives the play dollars first. */
export async function backFor(
  world: LiveWorld,
  project: LiveProject,
  who: string,
  dollars: bigint,
): Promise<bigint> {
  await giveDollars(world, who);
  const { planBack } = await import(
    "../../../../packages/creaton-core/src/pot/pot-plans.ts"
  );
  const { balanceOf } = await import(
    "../../../../packages/creaton-core/src/pot/pot-reads.ts"
  );
  const read = (to: string, data: string) => call(to, data);
  const before = await balanceOf(read, project.shares, who);
  const plan = await planBack(read, {
    dollar: project.dollar,
    treasury: project.treasury,
    amount: dollars * 1_000_000n,
  });
  if (!plan) throw new Error("the amount buys nothing");
  await walletOf(who).sendCalls(plan.calls, 31337);
  return (await balanceOf(read, project.shares, who)) - before;
}

/** The founder checks in (the weekly check-in, with a record hash), which also opens the door a lapse shut. */
export async function checkIn(
  world: LiveWorld,
  project: LiveProject,
): Promise<void> {
  await walletOf(world.who.founder).sendCalls(
    [pot.checkInCall(project.treasury, `0x${"5c".repeat(32)}`)],
    31337,
  );
}

/** Move the chain's clock forward by `seconds` and mine a block, as the quiet weeks of a project do. */
export async function passTime(seconds: number): Promise<void> {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine", []);
}
