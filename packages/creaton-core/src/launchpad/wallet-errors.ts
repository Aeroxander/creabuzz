/**
 * Wallet failures as readable errors. Kept apart from the effects adapter so
 * the copy layer can recognise a user rejection without importing the adapter.
 */

/** What a user-rejected wallet request reads as. Matched by `isUserRejection`. */
export const USER_REJECTED_MESSAGE = "You rejected the request in your wallet.";

/** EIP-1193 user-rejection code (ethers reports the string `ACTION_REJECTED`). */
const USER_REJECTED_CODE = 4001;

/** Turn a provider rejection (a plain `{code, message}`) into an `Error`. */
export function walletError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === USER_REJECTED_CODE || code === "ACTION_REJECTED") {
      return new Error(USER_REJECTED_MESSAGE);
    }
    if (typeof message === "string" && message.length > 0) {
      return new Error(message);
    }
  }
  return new Error("The wallet returned an error.");
}

/** True when a failure reason is the user declining in their wallet. */
export function isUserRejection(reason: string): boolean {
  return reason.includes(USER_REJECTED_MESSAGE);
}
