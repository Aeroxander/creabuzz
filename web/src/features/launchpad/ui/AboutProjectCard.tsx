/**
 * What a backer reads first on a sale page: who is behind the project, what it is for and how it plans to spend.
 *
 * It is the team's own statement and the card says so. The figures below it on the page (the raise, the supply, the
 * contracts, the locked Shares) are read from the network; this is what the team declares, kept apart from them.
 */

import { Card } from "@/shared/ui/card";

import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";

import { recordSaleCurrency } from "../chain";
import { formatMoney } from "../lib/amounts";
import type { LaunchRecord } from "../models";

export function AboutProjectCard({ record }: { record: LaunchRecord }) {
  const people = [record.author, ...record.team.map((member) => member.pubkey)];
  const { data: profiles } = useProfiles([...new Set(people)]);
  const story = record.longPitch;
  const named = record.team.filter((member) => member.pubkey !== record.author);
  const hasAnything =
    Boolean(story) ||
    Boolean(record.updateCadence) ||
    Boolean(record.budget) ||
    record.ipList.length > 0;
  if (!hasAnything) return null;
  return (
    <Card className="p-4 lg:col-span-2" data-testid="launch-about">
      <h2 className="text-base font-semibold">About this project</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        In the team&apos;s own words. The team says this; the network does not
        check it. The raise, the supply and the contracts below are read from
        the network.
      </p>
      {story ? (
        <p className="mt-2 whitespace-pre-wrap text-sm">{story}</p>
      ) : null}
      <dl className="mt-3 divide-y divide-black/10 text-sm dark:divide-white/10">
        <div className="flex justify-between gap-2 py-1.5">
          <dt className="text-muted-foreground">Behind it</dt>
          <dd data-testid="launch-about-team">
            {[
              resolveUserName(profiles?.[record.author], record.author),
              ...named.map(
                (member) =>
                  `${resolveUserName(profiles?.[member.pubkey], member.pubkey)}${member.role ? ` (${member.role})` : ""}`,
              ),
            ].join(", ")}
          </dd>
        </div>
        {record.budget ? (
          <div className="flex justify-between gap-2 py-1.5">
            <dt className="text-muted-foreground">Planned spending</dt>
            <dd className="tabular-nums" data-testid="launch-about-budget">
              Up to {formatMoney(record.budget, recordSaleCurrency(record))} a
              month
            </dd>
          </div>
        ) : null}
        {record.updateCadence ? (
          <div className="flex justify-between gap-2 py-1.5">
            <dt className="text-muted-foreground">Updates</dt>
            <dd>{record.updateCadence}</dd>
          </div>
        ) : null}
        {record.ipList.length > 0 ? (
          <div className="flex justify-between gap-2 py-1.5">
            <dt className="text-muted-foreground">Assets it commits</dt>
            <dd className="text-right">{record.ipList.join(", ")}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}
