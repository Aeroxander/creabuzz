/**
 * What a contributor project is, said in its header (the contributor plan's C3), each line as far as its source goes
 * (`lib/contributor-status.ts`): how it started, checked against the contributor kit's own launch event; how new Shares
 * are made and whether they can be traded, read from the Shares themselves (D76, D77). Unknown is said as unknown.
 */

import { useQuery } from "@tanstack/react-query";

import { contributorKit } from "../chain-config";
import { ethGetLogs, getRpcEndpoint } from "../chain";
import {
  contributorStatus,
  type Provenance,
  type RulesRead,
  TOPIC_CONTRIBUTOR_LAUNCHED,
} from "../lib/contributor-status";
import { addressTopic } from "../lib/work";
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
  const kit = contributorKit(chainId);
  // Made by the contributor kit: its launch event names this DAO. One read, kept: it never changes.
  const launched = useQuery({
    queryKey: ["launchpad", "contributor-provenance", chainId, kit, dao],
    enabled: kit !== null && dao !== null,
    queryFn: async () =>
      (
        await ethGetLogs(getRpcEndpoint(), {
          address: kit as string,
          topics: [
            TOPIC_CONTRIBUTOR_LAUNCHED,
            null,
            addressTopic(dao as string),
          ],
          fromBlock: "0x0",
          toBlock: "latest",
        })
      ).length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const provenance: Provenance =
    kit === null || dao === null
      ? "record"
      : launched.isLoading
        ? "reading"
        : launched.data === true
          ? "kit"
          : "record";
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
  return (
    <div className="max-w-60 text-right text-xs text-muted-foreground">
      {status.start ? (
        <p data-testid="contributor-note">{status.start}</p>
      ) : null}
      {status.shares ? (
        <p className="mt-0.5" data-testid="contributor-issuance">
          {status.shares}
        </p>
      ) : null}
      {status.trading ? (
        <p className="mt-0.5" data-testid="contributor-transfers">
          {status.trading}
        </p>
      ) : null}
    </div>
  );
}
