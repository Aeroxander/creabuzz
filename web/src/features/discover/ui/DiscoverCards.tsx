/**
 * The three card shapes of the Discover directory.
 *
 * Each card answers the Paperclip questions in order — *what is happening*
 * (the title + one line of state), *does it need me* (stage / open roles /
 * seats), *what do I do about it* (one primary CTA) — and every figure it
 * prints carries its provenance (`card.sources`, `teamSource`), so a reader
 * can tell a receipt-proven DAO from a project that has only been pitched.
 *
 * Addresses follow the fund-flow honesty convention
 * (`launchpad/lib/fund-flow.ts:375`): mono, titled in full, and linked only
 * when the chain has a known explorer — otherwise the raw address is shown
 * with the explorer gap stated instead of a dead link.
 */
import { Link } from "@tanstack/react-router";
import { ArrowRight, Users } from "lucide-react";

import type { DaoCard } from "@/features/discover/lib/directory";
import { canBackLaunch } from "@/features/discover/lib/directory";
import { launchCoord } from "@/features/feed/ui/LaunchVoteCard";
import { useLaunchFollows } from "@/features/feed/use-launch-follows";
import { LaunchCard } from "@/features/launchpad/ui/LaunchCard";
import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { effectiveStage, type Launch } from "@/features/launchpad/models";
import { ProgressBar } from "@/features/launchpad/ui/widgets";
import { relativeTime } from "@/shared/lib/relative-time";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { ProjectSummary } from "@/features/projects/lib/state";
import { RoleChip } from "@/features/projects/ui/BoardPage";

/** One address line: full value, mono, linked when an explorer is known. */
function AddressLine({
  address,
  label,
  url,
  chainId,
}: {
  address: string;
  label: string;
  url: string | null;
  chainId: number | null;
}) {
  return (
    <div className="min-w-0">
      <span className="text-2xs font-medium tracking-wide text-black/50 uppercase dark:text-white/50">
        {label}
      </span>
      {url ? (
        <a
          className="block font-mono text-xs break-all underline"
          href={url}
          rel="noopener noreferrer"
          target="_blank"
          title={address}
        >
          {address}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <span className="block font-mono text-xs break-all" title={address}>
          {address}
        </span>
      )}
      <span className="text-2xs text-black/50 dark:text-white/50">
        {url
          ? "link opens the block explorer"
          : chainId === null
            ? "chain unknown — no explorer link"
            : `no explorer known for chain ${chainId}`}
      </span>
    </div>
  );
}

export function DiscoverDaoCard({
  card,
  nameOf,
}: {
  card: DaoCard;
  nameOf: (pubkey: string) => string;
}) {
  const address = card.dao ?? card.contract?.address ?? null;
  const addressLabel = card.dao
    ? "DAO address"
    : card.contract
      ? `Contract · ${card.contract.role}`
      : "Onchain address";
  return (
    <li>
      <Card
        className="flex h-full flex-col gap-3 p-4"
        data-testid="discover-dao"
      >
        <div className="flex items-start justify-between gap-2">
          <Link
            className="min-w-0 flex-1 truncate text-base font-semibold hover:underline"
            data-testid="discover-dao-title"
            search={{ action: undefined, author: card.founder ?? undefined }}
            to="/projects/$projectId"
            params={{ projectId: card.projectId }}
          >
            {card.name}
          </Link>
          <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-2xs font-medium text-emerald-700 dark:text-emerald-300">
            DAO
          </span>
        </div>

        {address ? (
          <AddressLine
            address={address}
            chainId={card.chainId}
            label={addressLabel}
            url={card.addressUrl}
          />
        ) : (
          <p className="text-xs text-black/60 dark:text-white/60">
            No onchain address recorded on this relay yet.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5 text-2xs">
          <span className="inline-flex items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-black/60 dark:bg-white/10 dark:text-white/60">
            <Users className="h-3 w-3" aria-hidden />
            {card.teamSize ?? "—"} {card.teamSize === 1 ? "seat" : "seats"}
            {card.teamSource === "equity-map" ? " · equity map" : ""}
            {card.teamSource === "summon-receipt" ? " · minted at summon" : ""}
          </span>
          {card.openRoles.map((role) => (
            <RoleChip filled={false} key={role.slug} role={role} />
          ))}
        </div>

        {card.txUrl ? (
          <a
            className="text-2xs break-all underline"
            href={card.txUrl}
            rel="noopener noreferrer"
            target="_blank"
            title={card.summonTx ?? card.deploymentTx ?? undefined}
          >
            {card.summonTx ? "Summon" : "Deployment"} tx{" "}
            {truncatePubkey(card.summonTx ?? card.deploymentTx ?? "")}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 text-2xs text-black/50 dark:text-white/50">
          <span className="truncate" title={card.founder ?? undefined}>
            {card.founder ? nameOf(card.founder) : "founder not recorded"}
          </span>
          <span className="shrink-0">{card.sources.join(" · ")}</span>
        </div>

        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link
              search={{ action: undefined, author: card.founder ?? undefined }}
              to="/projects/$projectId"
              params={{ projectId: card.projectId }}
            >
              View project
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link
              search={{ action: "join", author: card.founder ?? undefined }}
              to="/projects/$projectId"
              params={{ projectId: card.projectId }}
            >
              Join
            </Link>
          </Button>
        </div>
      </Card>
    </li>
  );
}

export function DiscoverLaunchCard({ launch }: { launch: Launch }) {
  const follows = useLaunchFollows();
  const { data: profiles } = useProfiles([launch.record.author]);
  const founder = profiles?.[launch.record.author];
  const stage = effectiveStage(launch);
  const key = launchCoord(launch.record);
  return (
    <li data-testid="discover-launch">
      <LaunchCard
        bids={launch.bids.length}
        followDisabled={!follows.ready || follows.pending}
        followed={follows.followed.has(key)}
        footer={
          <div className="space-y-3">
            <ProgressBar quietWhenUnknown record={launch.record} />
            {/* A raise that is over stays listed (hiding it would make the
                directory lie by omission), but its CTA must not promise a bid
                the auction will not take — Review-Proven Rule 6. */}
            {canBackLaunch(stage) ? (
              <Button asChild className="w-full" size="sm">
                <Link
                  params={{ launchId: launch.record.id }}
                  search={{ action: "bid", author: launch.record.author }}
                  to="/launchpad/$launchId"
                >
                  Back this launch
                  <ArrowRight aria-hidden className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            ) : (
              <Button asChild className="w-full" size="sm" variant="outline">
                <Link
                  params={{ launchId: launch.record.id }}
                  search={{ action: undefined, author: launch.record.author }}
                  to="/launchpad/$launchId"
                >
                  View launch
                  <ArrowRight aria-hidden className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            )}
          </div>
        }
        founder={
          founder
            ? {
                name: resolveUserName(founder, launch.record.author),
                picture: founder.picture ?? null,
              }
            : undefined
        }
        onToggleFollow={() => follows.toggle(key)}
        record={launch.record}
        stage={stage}
        titleTestId="discover-launch-title"
        updates={launch.updates.length}
      />
    </li>
  );
}

export function DiscoverProjectCard({
  card,
  nameOf,
}: {
  card: ProjectSummary;
  nameOf: (pubkey: string) => string;
}) {
  const joinable = card.openRoles.length > 0;
  return (
    <li>
      <Card
        className="flex h-full flex-col gap-3 p-4"
        data-testid="discover-project"
      >
        <div className="flex items-start justify-between gap-2">
          <Link
            className="min-w-0 flex-1 truncate text-base font-semibold hover:underline"
            data-testid="discover-project-title"
            search={{ action: undefined, author: card.founder }}
            to="/projects/$projectId"
            params={{ projectId: card.projectId }}
          >
            {card.name}
          </Link>
          <span
            className={
              joinable
                ? "shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-2xs font-medium text-sky-700 dark:text-sky-300"
                : "shrink-0 rounded-full bg-black/5 px-2 py-0.5 text-2xs font-medium text-black/50 dark:bg-white/10 dark:text-white/50"
            }
            data-testid="discover-project-hiring"
          >
            {joinable ? `Hiring · ${card.openRoles.length} open` : "Roles full"}
          </span>
        </div>
        <p className="line-clamp-2 text-sm text-black/60 dark:text-white/60">
          {card.summary || "No pitch yet — open it and read the roles."}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {card.openRoles.map((role) => (
            <RoleChip filled={false} key={role.slug} role={role} />
          ))}
          {card.filledRoles > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-2xs font-medium text-black/50 dark:bg-white/10 dark:text-white/50">
              <Users className="h-3 w-3" aria-hidden />
              {card.members} {card.members === 1 ? "member" : "members"}
            </span>
          ) : null}
        </div>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 text-2xs text-black/50 dark:text-white/50">
          <span className="truncate" title={card.founder}>
            {nameOf(card.founder)}
          </span>
          <span className="shrink-0">
            Updated {relativeTime(card.updatedAt)}
          </span>
        </div>
        {joinable ? (
          <Button asChild size="sm">
            <Link
              search={{ action: "join", author: card.founder }}
              to="/projects/$projectId"
              params={{ projectId: card.projectId }}
            >
              Request to join
            </Link>
          </Button>
        ) : (
          <Button asChild size="sm" variant="outline">
            <Link
              search={{ action: undefined, author: card.founder }}
              to="/projects/$projectId"
              params={{ projectId: card.projectId }}
            >
              View project
            </Link>
          </Button>
        )}
      </Card>
    </li>
  );
}
