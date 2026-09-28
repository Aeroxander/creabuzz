import { useQuery } from "@tanstack/react-query";

import { Card } from "@/shared/ui/card";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import {
  type CheckedClause,
  type EnforcedClause,
  fetchMechanismState,
  verifyEnforced,
} from "../lib/enforced-check";
import { getRpcEndpoint } from "../chain";

/**
 * The enforcement register, CHECKED (OA.md/OAv2 Phase 3): `dao.json`'s
 * `x-ao.enforced` is a claim; this card reads it and verifies each clause
 * against live DAO config. A contradicted claim shows red and loud — that
 * visibility is the structural answer to auditability-washing. Unreadable =
 * "unverifiable", never a green light.
 */
export function EnforcementCard({ dao }: { dao: string }) {
  const doc = useQuery({
    queryKey: ["dao-json", relayHttpBaseUrl(), dao],
    queryFn: async (): Promise<EnforcedClause[] | null> => {
      const response = await fetch(`${relayHttpBaseUrl()}/dao.json`);
      if (!response.ok) return null;
      const body: unknown = await response.json();
      const register = (body as { extensions?: Record<string, unknown> })
        ?.extensions?.["x-ao.enforced"];
      return Array.isArray(register) ? (register as EnforcedClause[]) : null;
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const state = useQuery({
    queryKey: ["mechanism-state", getRpcEndpoint(), dao],
    queryFn: () => fetchMechanismState(getRpcEndpoint(), dao),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const register = doc.data ?? null;
  const checked: CheckedClause[] =
    register && state.data ? verifyEnforced(register, state.data) : [];

  return (
    <Card className="p-4" data-testid="enforcement-card">
      <h2 className="text-base font-semibold">Enforcement</h2>
      <p className="mt-1 text-xs text-black/60 dark:text-white/60">
        What this org says it enforces, checked against live contract config. A
        claim the chain contradicts is shown as contradicted — the register is a
        claim; this card is the check.
      </p>
      {doc.isLoading || state.isLoading ? (
        <p
          className="mt-2 text-sm text-black/60 dark:text-white/60"
          role="status"
        >
          Checking…
        </p>
      ) : checked.length === 0 ? (
        <p className="mt-2 text-sm text-black/60 dark:text-white/60">
          No enforcement register published yet — nothing is claimed, so nothing
          is checked.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {checked.map((row) => (
            <li
              key={row.detail}
              className="rounded-md border border-black/10 px-2 py-1 dark:border-white/10"
            >
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  row.status === "verified"
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : row.status === "contradicted"
                      ? "bg-red-500/15 text-red-700 dark:text-red-300"
                      : row.status === "documented"
                        ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
                        : "bg-muted text-muted-foreground"
                }`}
              >
                {row.status}
              </span>
              <p className="mt-1 text-xs text-black/70 dark:text-white/70">
                {row.detail}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
