import { useQuery } from "@tanstack/react-query";

import { invokeTauri } from "@/shared/api/tauri";
import {
  parseEnforcedRegister,
  SELECTOR_PROPOSAL_THRESHOLD,
  SELECTOR_RAGEQUITTABLE,
  verifyEnforced,
  type CheckedClause,
  type EnforcedClause,
} from "@/features/launchpad/lib/enforcedCheck";

/**
 * The enforcement register, CHECKED (web `EnforcementCard` parity): the
 * `x-ao.enforced` claims in the served dao.json verified against live DAO
 * config. Contradicted claims show red and loud; unreadable is never green.
 */
export function EnforcementCard({
  dao,
  rpcUrl,
  relayOrigin,
}: {
  dao: string | null;
  rpcUrl: string | null;
  relayOrigin: string | null;
}) {
  const doc = useQuery({
    queryKey: ["dao-json", relayOrigin, dao],
    queryFn: async (): Promise<EnforcedClause[] | null> => {
      if (!relayOrigin) return null;
      const response = await fetch(
        `${relayOrigin.replace(/\/+$/, "")}/dao.json`,
      );
      if (!response.ok) return null;
      return parseEnforcedRegister(await response.json());
    },
    enabled: Boolean(relayOrigin),
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const state = useQuery({
    queryKey: ["mechanism-state", rpcUrl, dao],
    queryFn: async () => {
      const read = async (data: string): Promise<bigint | null> => {
        try {
          const result = await invokeTauri<{ returnData: string }>("evm_call", {
            rpcUrl,
            to: dao,
            data,
          });
          return BigInt(result.returnData);
        } catch {
          return null;
        }
      };
      const [threshold, ragequittableWord] = await Promise.all([
        read(SELECTOR_PROPOSAL_THRESHOLD),
        read(SELECTOR_RAGEQUITTABLE),
      ]);
      return {
        proposalThreshold: threshold,
        ragequittable:
          ragequittableWord === null
            ? null
            : ragequittableWord === 1n
              ? true
              : ragequittableWord === 0n
                ? false
                : null,
      };
    },
    enabled: Boolean(rpcUrl && dao),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const register = doc.data ?? null;
  const checked: CheckedClause[] =
    register && state.data ? verifyEnforced(register, state.data) : [];

  return (
    <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
      <h3 className="text-sm font-semibold">Enforcement</h3>
      <p className="mt-1 text-2xs text-muted-foreground">
        What this org says it enforces, checked against live contract config. A
        claim the chain contradicts is shown as contradicted — the register is a
        claim; this card is the check.
      </p>
      {doc.isLoading || state.isLoading ? (
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          Checking…
        </p>
      ) : checked.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No enforcement register published yet — nothing is claimed, so nothing
          is checked.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {checked.map((row) => (
            <li
              key={row.detail}
              className="rounded-md border border-border/70 px-2 py-1"
            >
              <span
                className={`rounded-full px-2 py-0.5 text-2xs font-medium ${
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
              <p className="mt-1 text-2xs text-muted-foreground">
                {row.detail}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
