/**
 * The chain world's invariant readings.
 *
 * The four invariants are money invariants, so a chain-backed scene has to
 * *read them*, not tick them. Each reading below is a concrete equality over
 * the vault's real state; `holds` is what that equality returned. A run whose
 * readings were invented would be the exact failure `invariants.ts` exists to
 * prevent (Review-Proven Rule 1).
 *
 * Pure apart from the two `fetch`es: `tests/simulate/story-anvil.spec.ts`
 * supplies the endpoint and the addresses.
 */

import { checkAll, type Check } from "./invariants";

// balanceOf(address), totalSupply(), totalVouchers()
const BALANCE_OF = "0x70a08231";
const TOTAL_SUPPLY = "0x18160ddd";
const TOTAL_VOUCHERS = "0x98c48638";

const addr = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");

export async function rpc(
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** `eth_call` one 32-byte word, as a bigint. */
async function word(url: string, to: string, data: string): Promise<bigint> {
  const raw = (await rpc(url, "eth_call", [{ to, data }, "latest"])) as string;
  return BigInt(raw);
}

export interface VaultWorld {
  /** Currency held by the vault. */
  vaultCurrency: bigint;
  /** Currency the backer holds. */
  backerCurrency: bigint;
  /** Currency the treasury has taken in tax. */
  treasuryCurrency: bigint;
  /** Unspent vouchers. */
  vouchers: bigint;
  /** Currency committed to proposals' reserves. */
  reserved: bigint;
  /** Every project token in existence. */
  tokenSupply: bigint;
  /** Every project token held by the vault in escrow. */
  vaultTokens: bigint;
  /** Tokens held by the backer directly — must be none while escrowed. */
  backerTokens: bigint;
  /** The currency units the world started with, for conservation. */
  initialCurrency: bigint;
}

export async function readVaultWorld(
  url: string,
  a: {
    vault: string;
    currency: string;
    token: string;
    backer: string;
    treasury: string;
    /** Every proposal the world has opened — reserves have to be summed. */
    proposalIds: string[];
    initialCurrency: bigint;
  },
): Promise<VaultWorld> {
  // `proposals(bytes32)` returns min, max, deadline, checkHash, reserved,
  // escrowed, state — one word each. Every proposal's reserve counts: missing
  // one would read the vault as owing less than it does.
  let reservedAmount = 0n;
  for (const proposalId of a.proposalIds) {
    const raw = (await rpc(url, "eth_call", [
      { to: a.vault, data: `0x32ed5b12${addr(proposalId)}` },
      "latest",
    ])) as string;
    const words = raw.slice(2).match(/.{64}/g) ?? [];
    reservedAmount += BigInt(`0x${words[4] ?? "0"}`);
  }

  return {
    vaultCurrency: await word(url, a.currency, `${BALANCE_OF}${addr(a.vault)}`),
    backerCurrency: await word(
      url,
      a.currency,
      `${BALANCE_OF}${addr(a.backer)}`,
    ),
    treasuryCurrency: await word(
      url,
      a.currency,
      `${BALANCE_OF}${addr(a.treasury)}`,
    ),
    vouchers: await word(url, a.vault, TOTAL_VOUCHERS),
    reserved: reservedAmount,
    tokenSupply: await word(url, a.token, TOTAL_SUPPLY),
    vaultTokens: await word(url, a.token, `${BALANCE_OF}${addr(a.vault)}`),
    backerTokens: await word(url, a.token, `${BALANCE_OF}${addr(a.backer)}`),
    initialCurrency: a.initialCurrency,
  };
}

/**
 * The four invariants, each as one equality over the world above. Every detail
 * string names the equality, so a reader can check the reasoning and not just
 * the tick.
 */
export function invariantReadings(w: VaultWorld): Check[] {
  return checkAll((invariant) => {
    switch (invariant) {
      case "treasury-solvent":
        return {
          holds: w.vaultCurrency === w.vouchers + w.reserved,
          detail: `the vault holds ${w.vaultCurrency} currency and owes ${w.vouchers} unspent vouchers + ${w.reserved} reserved`,
        };
      case "supply-conserved":
        return {
          holds: w.tokenSupply === w.vaultTokens + w.backerTokens,
          detail: `the ${w.tokenSupply} project tokens are all accounted for: ${w.vaultTokens} still escrowed in the vault and ${w.backerTokens} already released to the backer`,
        };
      case "spend-within-allowance":
        return {
          holds:
            w.backerCurrency + w.vaultCurrency + w.treasuryCurrency ===
            w.initialCurrency,
          detail: `currency is conserved across the three accounts: ${w.backerCurrency} + ${w.vaultCurrency} + ${w.treasuryCurrency} = ${w.initialCurrency}`,
        };
      case "exits-neutral":
        return {
          holds: w.vaultCurrency - w.reserved >= w.vouchers,
          detail: `every one of the ${w.vouchers} unspent vouchers is covered by the ${w.vaultCurrency - w.reserved} the vault holds outside the ${w.reserved} committed to proposals, so leaving takes only what is the backer's`,
        };
    }
  });
}

/**
 * Act as an unlocked account on the node. The judge and the founder are
 * governance, and in this world governance is Anvil's account 0 — so a
 * settlement step is a real transaction, not a simulated one.
 */
export async function sendFrom(
  url: string,
  from: string,
  to: string,
  data: string,
): Promise<string> {
  return (await rpc(url, "eth_sendTransaction", [
    { from, to, data },
  ])) as string;
}

/** `anvil_mine` — the story's time jumps. */
export async function mine(url: string, blocks: number): Promise<void> {
  await rpc(url, "anvil_mine", [`0x${blocks.toString(16)}`]);
}

/** Whether a call would revert right now, without sending anything. */
export async function callReverts(
  url: string,
  from: string,
  to: string,
  data: string,
): Promise<boolean> {
  try {
    await rpc(url, "eth_call", [{ from, to, data }, "latest"]);
    return false;
  } catch {
    return true;
  }
}

/** The current block number. */
export async function blockNumber(url: string): Promise<number> {
  const raw = (await rpc(url, "eth_blockNumber", [])) as string;
  return Number(BigInt(raw));
}
