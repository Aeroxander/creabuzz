import { Copy } from "lucide-react";

import { useAuctionProgress } from "@/features/launchpad/ui/LaunchAuctionProgress";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { truncatePubkey } from "@/shared/lib/pubkey";
import type { Launch } from "@/features/launchpad/launchpadModels";

function AddressRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-2 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <button
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-2xs hover:bg-muted"
        onClick={() => void copyTextToClipboard(value)}
        title="Copy address"
        type="button"
      >
        <span className="truncate">{value}</span>
        <Copy className="h-3 w-3 shrink-0" />
      </button>
    </div>
  );
}

export function LaunchOverviewPanel({ launch }: { launch: Launch }) {
  const { record } = launch;
  const progress = useAuctionProgress(record);
  const raised = progress.data;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
        <h3 className="text-sm font-semibold">Raise terms</h3>
        <dl className="mt-2 divide-y divide-border/50 text-sm">
          <div className="flex justify-between gap-2 py-1">
            <dt className="text-muted-foreground">Raised</dt>
            <dd className="tabular-nums">
              {raised
                ? `${raised.raised.toString()} / ${raised.goal?.toString() ?? "—"}`
                : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-1">
            <dt className="text-muted-foreground">Bids mirrored</dt>
            <dd className="tabular-nums">{launch.bids.length}</dd>
          </div>
          <div className="flex justify-between gap-2 py-1">
            <dt className="text-muted-foreground">Floor price</dt>
            <dd className="tabular-nums">{record.floorPrice ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-2 py-1">
            <dt className="text-muted-foreground">Admission</dt>
            <dd>
              {record.admission === "community"
                ? "Community track"
                : "Curated track"}
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-1">
            <dt className="text-muted-foreground">Chain</dt>
            <dd className="tabular-nums">{record.chainId ?? "Undeployed"}</dd>
          </div>
        </dl>
        {raised && raised.source === "preview" ? (
          <p className="mt-2 text-2xs text-muted-foreground">
            Preview fixture — link an auction contract and point the launchpad
            at a chain RPC for live values.
          </p>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
        <h3 className="text-sm font-semibold">Contracts</h3>
        <div className="mt-1 divide-y divide-border/50">
          <AddressRow label="Auction" value={record.auction} />
          <AddressRow label="Token" value={record.token} />
          <AddressRow label="Treasury" value={record.treasury} />
          {record.hooks.map((hook) => (
            <AddressRow
              key={`${hook.address}:${hook.bucket}`}
              label={`Hook (${hook.bucket})`}
              value={hook.address}
            />
          ))}
          {!record.auction && !record.token && !record.treasury ? (
            <p className="py-2 text-sm text-muted-foreground">
              No contracts deployed yet — this launch is still lining up its
              raise.
            </p>
          ) : null}
        </div>
        {record.website ? (
          <a
            className="mt-2 inline-block text-sm text-primary hover:underline"
            href={record.website}
            rel="noreferrer"
            target="_blank"
          >
            Website →
          </a>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3 lg:col-span-2">
        <h3 className="text-sm font-semibold">Team</h3>
        {record.team.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Founder key:{" "}
            <span className="font-mono text-2xs">
              {truncatePubkey(record.author)}
            </span>
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {record.team.map((member) => (
              <li
                key={member.pubkey}
                className="flex items-center gap-2 text-sm"
              >
                <span className="font-mono text-2xs text-muted-foreground">
                  {truncatePubkey(member.pubkey)}
                </span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-2xs uppercase tracking-wide text-muted-foreground">
                  {member.role}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
