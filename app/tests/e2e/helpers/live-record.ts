/**
 * The server's reading of a project, made from the real chain for a browser spec: record version 2 (docs/next-version/
 * RECORD-V2.md), every figure read from the contracts' own views, the settled money worked forward to the chain's clock by
 * section 3 of that document, the totals summed from the Treasury's own events. It stands in for the server's chain reader
 * (which the server track tests on its own); the page under test sees a record signed by the "server" key and nothing else
 * about it is different. The example file is the shape: every field this does not read from the chain is the example's.
 */
import {
  decodeReturn,
  encodeCall,
  signatureOf,
} from "../../../../packages/creaton-core/src/pot/abi-codec.ts";
import type { Abi } from "../../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  PAIR_ABI,
  SHARE_TOKEN_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "../../../../packages/creaton-core/src/pot/abis.generated.ts";
import { topicOf } from "../../../../packages/creaton-core/src/launchpad/work.ts";
import { call, rpc } from "../../anvil/rpc";
import { numbersV2Content } from "../../helpers/numbers-v2-fixture";
import { chainNow, type LiveProject, type LiveWorld } from "./live-chain";
import { liveTasks } from "./live-tasks";
import { readStored, rollForward } from "./live-settled";

type Json = Record<string, unknown>;

async function view(
  abi: Abi,
  to: string,
  name: string,
  args: (bigint | string)[] = [],
): Promise<bigint | string | boolean> {
  const out = decodeReturn(
    abi,
    name,
    await call(to, encodeCall(abi, name, args)),
    args.length,
  );
  return out[0] as bigint | string | boolean;
}

const big = (v: unknown) => BigInt(v as bigint);
const text = (v: bigint) => v.toString();

interface Log {
  topics: string[];
  data: string;
  blockNumber: string;
}

async function logsOf(
  address: string,
  abi: Abi,
  event: string,
): Promise<Log[]> {
  const item = abi.find((i) => i.type === "event" && i.name === event);
  if (!item) throw new Error(`no event ${event}`);
  return rpc<Log[]>("eth_getLogs", [
    {
      address,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [topicOf(signatureOf(item))],
    },
  ]);
}

/** The n-th 32-byte word of a log's data. */
const wordOf = (log: Log, n: number) =>
  BigInt(`0x${log.data.slice(2 + n * 64, 2 + (n + 1) * 64)}`);
const sum = (logs: Log[], n: number) =>
  logs.reduce((total, log) => total + wordOf(log, n), 0n);

/** What the Treasury's `TaskMoney` events of one kind moved (word 0 is the kind, word 2 the amount). */
const sumKind = (logs: Log[], kind: bigint) =>
  logs
    .filter((log) => wordOf(log, 0) === kind)
    .reduce((total, log) => total + wordOf(log, 2), 0n);

export interface RecordOptions {
  /** Unix seconds at the browser: the record was built 5 seconds before it. Default: the chain's own clock. */
  now?: number;
  /** Accounts to list as holders (the lists the server keeps are built from events; a spec names who it used). */
  holders?: string[];
  /** The last record hash the server saw in a check-in. */
  recordHash?: string | null;
  /** The server also follows the project's task book: the record carries the `tasks` section read from the chain. */
  tasks?: boolean;
  /** Change the record before it is returned (a stale one, one the server could not finish). */
  patch?: (content: Json) => void;
}

/** The record's content for `project`, as of the chain's latest block. */
export async function liveRecord(
  world: LiveWorld,
  project: LiveProject,
  options: RecordOptions = {},
): Promise<Json> {
  const at = options.now ?? (await chainNow());
  const content = numbersV2Content({
    coordinate: project.coordinate,
    now: at,
    patch: undefined,
  });
  const tr = project.treasury;
  const T = (name: string, args: (bigint | string)[] = []) =>
    view(TREASURY_ABI, tr, name, args);
  const unit = big(await T("unit"));
  const block = Number.parseInt(await rpc<string>("eth_blockNumber"), 16);
  const t = BigInt(await chainNow());

  // Section 3: the stored pot, box, arriving and active seconds worked forward to the chain's clock.
  const last = big(await T("lastSettle"));
  const end = big(await T("activeEnd"));
  const rate = big(await T("ratePpm"));
  const arrivalEnd = big(await T("arrivalEnd"));
  const settled = rollForward(t, await readStored(tr, t));
  const { pot, box, arriving, locked } = settled;
  const active = settled.activeSeconds;

  const supply = big(
    await view(SHARE_TOKEN_ABI, project.shares, "totalSupply"),
  );
  const teamSupply = big(
    await view(SHARE_TOKEN_ABI, project.team, "totalSupply"),
  );
  const inVester = big(
    await view(SHARE_TOKEN_ABI, project.team, "balanceOf", [project.vester]),
  );
  const dollarHeld = big(
    await view(SHARE_TOKEN_ABI, project.dollar, "balanceOf", [tr]),
  );
  const lastCheckIn = Number(await T("lastCheckIn"));
  const windKind = Number(big(await T("windDownKind")));
  const windAt = Number(big(await T("windDownAt")));
  const u = Number(unit);
  const woundDown = windKind !== 0;
  const checkInMult = Number(big(await T("CHECK_IN_MULT")));
  const windMult = Number(big(await T("WIND_MULT")));
  const quietFrom = lastCheckIn + checkInMult * u;
  const dormantFrom = lastCheckIn + 13 * u;
  const windableFrom = lastCheckIn + windMult * u;
  const now = Number(t);
  const state = woundDown
    ? "wound_down"
    : now < quietFrom
      ? "active"
      : now < dormantFrom
        ? "quiet"
        : now < windableFrom
          ? "dormant"
          : "may_wind_down";
  const next =
    woundDown || state === "may_wind_down"
      ? null
      : state === "active"
        ? { state: "quiet", at: quietFrom }
        : state === "quiet"
          ? { state: "dormant", at: dormantFrom }
          : { state: "may_wind_down", at: windableFrom };
  const since = woundDown
    ? windAt
    : state === "active"
      ? lastCheckIn
      : state === "quiet"
        ? quietFrom
        : state === "dormant"
          ? dormantFrom
          : windableFrom;

  const joined = await logsOf(tr, TREASURY_ABI, "Joined");
  const left = await logsOf(tr, TREASURY_ABI, "Left");
  const teamLeft = await logsOf(tr, TREASURY_ABI, "TeamLeft");
  const drawn = await logsOf(tr, TREASURY_ABI, "AllowanceDrawn");
  const outside = await logsOf(tr, TREASURY_ABI, "RevenueAdded");
  const taskMoney = await logsOf(tr, TREASURY_ABI, "TaskMoney");
  let firstBackedAt: number | null = null;
  if (joined[0]) {
    const b = await rpc<{ timestamp: string }>("eth_getBlockByNumber", [
      joined[0].blockNumber,
      false,
    ]);
    firstBackedAt = Number.parseInt(b.timestamp, 16);
  }

  const known = options.holders ?? [
    world.who.backer,
    world.who.second,
    world.who.stranger,
  ];
  const holders: Json[] = [];
  for (const account of known) {
    const shares = big(
      await view(SHARE_TOKEN_ABI, project.shares, "balanceOf", [account]),
    );
    const teamShares = big(
      await view(SHARE_TOKEN_ABI, project.team, "balanceOf", [account]),
    );
    if (shares > 0n || teamShares > 0n)
      holders.push({
        account,
        shares: text(shares),
        teamShares: text(teamShares),
      });
  }
  holders.sort((a, b) =>
    BigInt(b.shares as string) > BigInt(a.shares as string) ? 1 : -1,
  );

  const pendingAt = Number(big(await T("pendingAt")));
  const pendingRate = Number(big(await T("pendingRatePpm")));
  const runnerAddress = String(await T("runner")).toLowerCase();
  // A Pair runs it when the Launcher made the runner: its two signers are the Pair's own.
  const runnerIsPair =
    (await view(LAUNCHER_ABI, project.launcher, "isPair", [runnerAddress])) ===
    true;
  const signers = runnerIsPair
    ? [
        String(await view(PAIR_ABI, runnerAddress, "first")).toLowerCase(),
        String(await view(PAIR_ABI, runnerAddress, "second")).toLowerCase(),
      ]
    : null;
  const paidIn = big(await T("paidIn"));
  const feesOwed = big(await T("feesOwed"));
  const claimedGrants = Number(
    big(await view(VESTER_ABI, project.vester, "grantCount")),
  );

  Object.assign(content, {
    version: 2,
    chainId: 31337,
    launcher: project.launcher,
    key: project.key,
    projectId: project.projectId,
    founder: world.who.founder,
    launchedAt: project.launchedAt,
    playMoney: true,
    contracts: {
      treasury: tr,
      shares: project.shares,
      team: project.team,
      vester: project.vester,
      dollar: project.dollar,
      pair: runnerIsPair ? runnerAddress : null,
    },
    asOf: { block, time: now },
    builtAt: at - 5,
    refreshEverySecs: 600,
    unit: u,
    fee: { bps: Number(big(await T("feeBps"))) },
    money: {
      pot: text(pot),
      paidIn: text(paidIn),
      arriving: text(arriving),
      arrivalEnd: arriving === 0n ? null : Number(arrivalEnd),
      feesOwed: text(feesOwed),
      locked: text(locked),
      notesOwed: text(big(await T("notesOwed"))),
      held: text(dollarHeld),
    },
    shares: {
      backers: text(supply),
      teamCounted: text(teamSupply),
      announcedBurn: "0",
    },
    value: {
      leaveValue: text(big(await T("leaveValue"))),
      teamValue: text(big(await T("teamValue"))),
    },
    allowance: {
      ratePpm: Number(rate),
      pending:
        pendingAt === 0
          ? null
          : {
              ratePpm: pendingRate,
              proposedAt: pendingAt,
              applicableAt: pendingAt + u,
            },
      box: text(box),
      boxCap: text(big(await T("boxCap"))),
      drawnLastDay: "0",
    },
    clock: {
      lastCheckIn,
      lastRecordHash: options.recordHash ?? null,
      activeUntil: woundDown ? null : Number(end),
      activeSeconds: Number(active),
    },
    door: {
      switchOn: Boolean(await T("doorFlag")),
      openNow: Boolean(await T("doorOpenNow")),
      shutsAt: woundDown ? null : Number(end),
    },
    quiet: {
      state,
      since,
      quietFrom: woundDown ? null : quietFrom,
      dormantFrom: woundDown ? null : dormantFrom,
      windableFrom: woundDown ? null : windableFrom,
      next,
    },
    windDown: woundDown ? { kind: windKind, at: windAt } : null,
    runner: { address: runnerAddress, isPair: runnerIsPair, signers },
    team: {
      pool: text(10_000_000n * 10n ** 18n),
      inHands: text(teamSupply - inVester),
      inVester: text(inVester),
      promised: "0",
      ungranted: text(inVester),
      grantCount: claimedGrants,
      grants: [],
    },
    agents: [],
    limits: {
      minJoin: text(big(await T("MIN_JOIN"))),
      minOutsidePayment: text(big(await T("MIN_REVENUE"))),
      maxRatePpm: Number(big(await T("MAX_RATE_PPM"))),
      checkInWindowUnits: checkInMult,
      windDownUnits: windMult,
      cliffUnits: Number(
        big(await view(VESTER_ABI, project.vester, "CLIFF_MULT")),
      ),
      vestUnits: Number(
        big(await view(VESTER_ABI, project.vester, "VEST_MULT")),
      ),
      minGrant: text(big(await view(VESTER_ABI, project.vester, "MIN_GRANT"))),
      maxGrantsPerMember: Number(
        big(await view(VESTER_ABI, project.vester, "MAX_GRANTS_PER_MEMBER")),
      ),
      agentUsdPerDay: text(big(await T("agentUsd"))),
      agentTeamPerDay: text(big(await T("agentTeam"))),
    },
    totals: {
      joined: text(sum(joined, 0)),
      fees: text(sum(joined, 1)),
      tookOut: text(sum(left, 1) + sum(teamLeft, 1)),
      drawn: text(sum(drawn, 0)),
      outside: text(sum(outside, 0)),
      paidToWorkers: text(sumKind(taskMoney, 2n)),
      noteClaims: text(sumKind(taskMoney, 6n)),
    },
    firstBackedAt,
    holders,
    holderCount: holders.filter((h) => h.shares !== "0").length,
    teamHolderCount: holders.filter((h) => h.teamShares !== "0").length,
    truncated: false,
  });
  // The stored numbers as of the last settle, which section 3 of the record's spec works forward from (for checks only).
  content.ledger = {
    lastSettle: Number(last),
    pot: text(big(await T("pot"))),
    box: text(big(await T("box"))),
    arriving: text(big(await T("arriving"))),
    arrivalEnd: big(await T("arriving")) === 0n ? null : Number(arrivalEnd),
    arrivalStart: Number(big(await T("arrivalStart"))),
    arrivalTotal: text(big(await T("arrivalTotal"))),
    activeSeconds: Number(big(await T("activeSeconds"))),
    locked: text(big(await T("locked"))),
    notesOwed: text(big(await T("notesOwed"))),
  };
  if (options.tasks) content.tasks = await liveTasks(project, now, pot, u);
  options.patch?.(content);
  return content;
}
