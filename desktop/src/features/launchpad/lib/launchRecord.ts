import { KIND_LAUNCH_RECORD } from "@/shared/constants/kinds";
import type { LaunchStage } from "@/features/launchpad/launchpadModels";

export type TokenPlan =
  | { mode: "mint"; name: string; symbol: string; supply: string }
  | { mode: "import"; address: string };

export type CreateLaunchInput = {
  id: string;
  name: string;
  pitch: string;
  stage: LaunchStage;
  chainId: string;
  currency: string;
  floorPrice: string;
  tickSpacing: string;
  requiredRaised: string;
  auction: string;
  token: string;
  treasury: string;
  admission: "curated" | "community";
  channels: string[];
  tokenPlan?: TokenPlan;
};

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function isLaunchSlug(value: string): boolean {
  return SLUG_RE.test(value.trim());
}

export function isEvmAddress(value: string): boolean {
  return ADDR_RE.test(value.trim());
}

/** Whole-token supply for humans; the chain uses 18 decimals. */
export function isWholeTokenSupply(value: string): boolean {
  if (!/^\d+$/.test(value.trim())) return false;
  try {
    return BigInt(value.trim()) > 0n;
  } catch {
    return false;
  }
}

/** Suggest a symbol from a launch name: first letters, uppercase. */
export function suggestSymbol(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  if (letters.length === 0) return "";
  return letters.slice(0, 4);
}

/** Opinionated dev defaults. Everything is editable; nothing is hidden. */
export const LAUNCH_DEFAULTS = {
  chainId: "11155111",
  currency: "",
  floorPrice: "1000000",
  tickSpacing: "100",
  requiredRaised: "1000000000",
  supply: "1000000",
  admission: "curated",
} as const;

export function buildLaunchRecordTemplate(input: CreateLaunchInput): {
  kind: number;
  content: string;
  tags: string[][];
} {
  const tags: string[][] = [
    ["d", input.id],
    ["name", input.name],
    ["t", "dao-launchpad"],
    ["admission", input.admission],
  ];
  if (input.chainId) tags.push(["chain", input.chainId]);
  if (input.auction) tags.push(["auction", input.auction]);
  if (input.token) tags.push(["token", input.token]);
  if (input.treasury) tags.push(["treasury", input.treasury]);
  for (const channel of input.channels) tags.push(["buzz-channel", channel]);
  const content: Record<string, unknown> = {
    pitch: input.pitch,
    stage: input.stage,
  };
  if (input.currency) content.currency = input.currency;
  if (input.floorPrice) content.floorPrice = input.floorPrice;
  if (input.tickSpacing) content.tickSpacing = input.tickSpacing;
  if (input.requiredRaised) content.requiredRaised = input.requiredRaised;
  if (input.tokenPlan) content.tokenPlan = input.tokenPlan;
  return { kind: KIND_LAUNCH_RECORD, content: JSON.stringify(content), tags };
}

/** Exact CLI mint command for a mint-mode plan (copy-paste handoff). */
export function mintCommandForPlan(input: {
  tokenName: string;
  symbol: string;
  supply: string;
  treasury: string;
}): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return [
    "buzz launchpad mint-token",
    `--name ${quote(input.tokenName)}`,
    `--symbol ${input.symbol}`,
    `--supply ${input.supply}`,
    `--treasury ${input.treasury}`,
  ].join(" ");
}
