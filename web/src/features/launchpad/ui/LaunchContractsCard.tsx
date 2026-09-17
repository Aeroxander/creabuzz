import { useMemo } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { Card } from "@/shared/ui/card";

import type { LaunchRecord } from "../models";

/**
 * The addresses a launch commits to, and the people behind them.
 *
 * One batched profile query names the founder and every listed teammate for the
 * whole card. The contract rows keep their raw addresses: a contract is not a
 * person, and an abbreviated address is not an identity.
 */
export function LaunchContractsCard({ record }: { record: LaunchRecord }) {
  const people = useMemo(
    () => [...new Set([record.author, ...record.team.map((m) => m.pubkey)])],
    [record.author, record.team],
  );
  const userNames = useUserNames(people);

  return (
    <Card className="p-4">
      <h2 className="text-base font-semibold">Contracts</h2>
      {[
        ["Auction", record.auction],
        ["Token", record.token],
        ["Treasury", record.treasury],
      ].map(([label, value]) => (
        <div
          key={label}
          className="flex items-center justify-between gap-2 py-1.5 text-sm"
        >
          <span className="text-black/60 dark:text-white/60">{label}</span>
          <span className="truncate font-mono text-xs">{value ?? "—"}</span>
        </div>
      ))}
      <h2 className="mt-4 text-base font-semibold">Team</h2>
      {record.team.length === 0 ? (
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          {userNames(record.author)}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {record.team.map((m) => (
            <li key={m.pubkey} className="flex items-center gap-2 text-sm">
              <span className="text-xs text-black/60 dark:text-white/60">
                {userNames(m.pubkey)}
              </span>
              <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs uppercase dark:bg-white/10">
                {m.role}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
