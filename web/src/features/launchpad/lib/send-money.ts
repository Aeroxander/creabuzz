/**
 * Sending money out of a passkey account (D141). A passkey account receives money like any wallet (a paid claim, a
 * deposit or bond coming back, what leaving a project pays), but no wallet app holds it, so the app has to offer the
 * one thing a wallet app would: send it somewhere else. This turns what the person typed into the one call that does it
 * (a token `transfer`, or plain ETH), or says in plain words why it cannot be sent. Pure, so `send-money.test.mjs` pins it.
 */

import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";

import type { SenderCall } from "../../identity/lib/sponsoredSender.ts";
import { formatUnits, parseUnits } from "./dao-actions.ts";

/** Money the account holds of one kind. `token` is null for ETH. */
export interface MoneyHeld {
  token: string | null;
  symbol: string;
  decimals: number;
  balance: bigint;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;

/** An amount as people read it, every digit kept. */
export function moneyText(held: MoneyHeld, amount = held.balance): string {
  return formatUnits(amount, held.decimals, held.decimals);
}

/** The same amount as the amount field takes it, with no thousands separators (what "All of it" fills in). */
export function moneyInput(held: MoneyHeld, amount = held.balance): string {
  return moneyText(held, amount).replace(/,/g, "");
}

/** The one call that sends `amountText` of `held` from `from` to `to`, with a sentence saying it; or why it cannot. */
export function sendMoneyPlan(input: {
  held: MoneyHeld;
  amountText: string;
  to: string;
  from: string;
}):
  | { problem: string }
  | { call: SenderCall; summary: string; amount: bigint } {
  const { held } = input;
  const to = input.to.trim();
  if (!ADDRESS_RE.test(to) || ZERO.test(to)) {
    return {
      problem:
        "Paste the full address to send to: 0x and 40 letters or numbers.",
    };
  }
  if (to.toLowerCase() === input.from.toLowerCase()) {
    return {
      problem:
        "That is this account's own address. Paste the address you want the money to go to.",
    };
  }
  let amount: bigint;
  try {
    amount = parseUnits(
      input.amountText.trim(),
      held.decimals,
      "amount",
      "The amount",
    );
  } catch (error) {
    return {
      problem: error instanceof Error ? error.message : "Check the amount.",
    };
  }
  if (amount <= 0n) return { problem: "Send more than nothing." };
  if (amount > held.balance) {
    return { problem: `This account holds ${moneyText(held)} ${held.symbol}.` };
  }
  const recipient = to.toLowerCase();
  const call: SenderCall = held.token
    ? {
        to: held.token,
        data: encodeFunctionData(
          "transfer(address,uint256)",
          ["address", "uint256"],
          [recipient, amount],
        ),
      }
    : { to: recipient, data: "0x", value: `0x${amount.toString(16)}` };
  return {
    call,
    amount,
    summary: `Send ${moneyText(held, amount)} ${held.symbol} to ${recipient}`,
  };
}
