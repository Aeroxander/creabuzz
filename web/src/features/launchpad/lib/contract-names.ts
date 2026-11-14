/**
 * Plain names for the DAO's own contracts that can hold Shares, so the list of who holds them does not show a stranger's
 * address that is really "the reviewers' bonds". Keyed by lowercase address.
 */

interface MandateAddresses {
  address: string;
  verifiersAddress: string;
  claimsAddress: string;
  isMilestonePanel: boolean;
}

export function contractNames(
  work: { mandates: readonly MandateAddresses[] } | undefined,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const mandate of work?.mandates ?? []) {
    names.set(
      mandate.address.toLowerCase(),
      mandate.isMilestonePanel ? "Milestone reviewers" : "A work budget",
    );
    names.set(mandate.verifiersAddress.toLowerCase(), "Reviewers' bonds");
    names.set(mandate.claimsAddress.toLowerCase(), "Contributors' deposits");
  }
  return names;
}
