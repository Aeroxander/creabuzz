import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { invokeTauri } from "@/shared/api/tauri";

import { ORG_STALE_TIME_MS, ORG_GC_TIME_MS, orgQueryKey } from "./shared";

// ── Ragequit / exit (dev-first, NIP-ORG onchain binding) ──────────────────

/** Result of a settled ragequit (from the `org_ragequit` Tauri command). */
export type OrgRagequitResult = {
  txHash: string;
  dao: string;
  sharesBurned: string;
  sharesRemaining: string;
  lootRemaining: string;
};

/** Value-layer env presence (hint-only — no gates). */
export type OrgEvmStatus = {
  rpcConfigured: boolean;
  spenderConfigured: boolean;
};

/**
 * Whether the value-layer env (BUZZ_EVM_RPC_URL / BUZZ_SPENDER_KEY) is
 * configured. Read-only; drives the "configure EVM key" hint vs. the exit
 * action. DEV mapping: the configured spender key IS the shareholder.
 */
export function useOrgEvmStatusQuery(enabled = true) {
  return useQuery({
    queryKey: [...orgQueryKey, "evm-status"],
    queryFn: () => invokeTauri<OrgEvmStatus>("org_evm_status"),
    staleTime: ORG_STALE_TIME_MS,
    gcTime: ORG_GC_TIME_MS,
    enabled,
  });
}

/**
 * Ragequit the bound DAO from the configured value-layer spender key (the
 * DEV shareholder mapping). On settlement the org queries invalidate — the
 * binding's own Nostr record does not change, but dashboards reading
 * budgets/consumption should refresh. Shares are decimal strings (uint256).
 */
export function useOrgRagequitMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      dao: string;
      shares?: string;
      tokens?: string[];
    }): Promise<OrgRagequitResult> =>
      invokeTauri<OrgRagequitResult>("org_ragequit", {
        dao: input.dao,
        shares: input.shares ?? null,
        tokens: input.tokens ?? [],
      }),
    onSuccess: async () => {
      for (const leaf of ["chart", "nodes", "grants", "budgets", "audit"]) {
        await queryClient.invalidateQueries({
          queryKey: [...orgQueryKey, leaf],
        });
      }
    },
  });
}
