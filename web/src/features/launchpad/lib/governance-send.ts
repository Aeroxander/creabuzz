import { ethChainId, ethTransactionReceipt } from "../chain.ts";
import { resolveSender, type SenderChoice } from "./sender-choice.ts";

/** Governance sends must use the chain from the displayed allowance preview. */
export async function sendGovernanceCall(
  choice: SenderChoice & { chainId: number },
  endpoint: string,
  dao: string,
  data: string,
): Promise<string> {
  if (choice.kind === "wallet" && !choice.wallet)
    throw new Error("Connect a voting wallet before sending this action.");
  const expected = await ethChainId(endpoint);
  const actual =
    choice.kind === "wallet"
      ? BigInt(String(await choice.wallet?.request({ method: "eth_chainId" })))
      : BigInt(choice.chainId);
  if (actual !== expected)
    throw new Error(
      `Select chain ${expected} in your wallet and RPC before voting.`,
    );
  const result = await resolveSender(choice).sendCalls([
    { to: dao, data, value: "0x0" },
  ]);
  if (!/^0x[0-9a-fA-F]{64}$/.test(result.txHash))
    throw new Error("The sender returned an invalid transaction hash.");
  return result.txHash;
}

/** Keep the voting action pending until mined, with a bounded confirmation window. */
export async function confirmGovernanceTransaction(
  endpoint: string,
  hash: string,
  options: {
    timeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 120_000);
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    const receipt = await ethTransactionReceipt(endpoint, hash);
    if (receipt !== null) {
      if (receipt?.status === "0x1") return;
      throw new Error(
        `Transaction ${hash} reverted or returned an unreadable receipt. Check the transaction before trying again.`,
      );
    }
    if (now() >= deadline)
      throw new Error(
        `Transaction ${hash} was submitted but is not confirmed. Check its status before trying again.`,
      );
    await sleep(1500);
  }
}
