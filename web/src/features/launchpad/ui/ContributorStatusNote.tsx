/**
 * What a contributor project is, said in its header (the contributor plan's C3), each line as far as its source goes
 * (`lib/contributor-status.ts`): how it started, checked against the contributor kit's own launch event; how new Shares
 * are made and whether they can be traded, read from the Shares themselves (D76, D77). Unknown is said as unknown.
 */

import { Award, Ban, Lock, LockOpen, TriangleAlert } from "lucide-react";

import { Chip } from "@/shared/ui/chip";
import {
  contributorStatus,
  type RulesRead,
  type StatusChip,
} from "../lib/contributor-status";
import { raisesOffered } from "../lib/raises-offered";
import { useContributorProvenance } from "../use-contributor-provenance";
import { useShareRules } from "../use-share-rules";

export function ContributorStatusNote({
  shares,
  dao,
  chainId,
}: {
  /** The project's Shares token; null when the record names none. */
  shares: string | null;
  dao: string | null;
  chainId: string | null;
}) {
  // Made by the contributor kit: its launch event names this DAO.
  const { provenance } = useContributorProvenance(chainId, dao);
  const read = useShareRules(shares, dao);
  const rules: RulesRead =
    shares === null || read.isError
      ? { kind: "error" }
      : read.data?.predates
        ? { kind: "predates" }
        : read.data?.rules
          ? { kind: "rules", rules: read.data.rules }
          : { kind: "reading" };
  const status = contributorStatus(provenance, rules);
  const chip = (item: StatusChip | null, icon: typeof Ban, testId: string) =>
    item ? (
      <Chip
        data-testid={testId}
        icon={item.tone === "caution" ? TriangleAlert : icon}
        tone={item.tone === "caution" ? "warning" : "neutral"}
      >
        {item.label}
      </Chip>
    ) : null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="contributor-chips">
      {/* A build with no sales never brings sales up, not even to say there was none. */}
      {raisesOffered() ? chip(status.start, Ban, "contributor-note") : null}
      {chip(status.shares, Award, "contributor-issuance")}
      {chip(
        status.trading,
        status.trading?.label === "Shares can be sold" ? LockOpen : Lock,
        "contributor-transfers",
      )}
    </div>
  );
}
