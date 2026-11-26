/**
 * "0x3c44…93bc": the short form of a wallet address, for a line of words a person reads. A full address never sits
 * mid-sentence; the whole address is always available where it can be checked (the details, the wallet's own
 * confirmation). One helper for every screen that names an account it has no name for.
 */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
