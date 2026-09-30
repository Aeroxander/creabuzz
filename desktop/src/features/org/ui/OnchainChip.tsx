import { Link2 } from "lucide-react";

/** Read-only label for a bound chain id (EIP-155 or dev chains). */
export function chainLabel(chain: string): string {
  const KNOWN: Record<string, string> = {
    "eip155:1": "Ethereum",
    "eip155:8453": "Base",
    "eip155:84532": "Base Sepolia",
    "eip155:11155111": "Sepolia",
    "anvil-31337": "Anvil",
  };
  return KNOWN[chain] ?? chain;
}

/** Truncate a 0x… address to its head and tail for display. */
export function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

type OnchainChipProps = {
  chain: string;
  /** DAO or allowance contract address. */
  address: string;
  /** Tooltip text; the chip's visible text carries the same information. */
  label: string;
};

/**
 * Read-only chip for an onchain binding (NIP-ORG §37012 budget binding or a
 * root-node DAO binding). Display only — no actions.
 */
export function OnchainChip({ chain, address, label }: OnchainChipProps) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground"
      title={label}
    >
      <Link2 aria-hidden="true" className="h-3 w-3" />
      <span aria-hidden="true">
        {chainLabel(chain)} · {truncateAddress(address)}
      </span>
    </span>
  );
}
