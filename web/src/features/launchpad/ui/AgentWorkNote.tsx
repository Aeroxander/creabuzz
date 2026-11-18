/**
 * One plain line, shown to everyone, when agents do some of a project's work: who answers for them. An agent counts
 * when it is on the team, or took a recent task (`lib/agent-work.ts`). The operator is named only where the record
 * proves who runs the agent; otherwise the line says only that the records do not say.
 */

import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  agentWorkLine,
  operatorsOf,
  recentTaskAgents,
} from "../lib/agent-work";
import type { Launch } from "../models";
import { readAccountAgent } from "../use-account-agent";
import { useProjectTeam } from "../use-team";
import { useProjectTasks } from "../use-tasks";

export function AgentWorkNote({ launch }: { launch: Launch }) {
  const team = useProjectTeam(launch);
  const work = useProjectTasks(launch.record);
  const relay = relayWsUrl();
  // Only people who said yes: someone added and not yet answered is not doing the work.
  const members = useMemo(
    () =>
      team.view.members
        .filter((member) => member.state === "accepted")
        .map((member) => member.pubkey),
    [team.view.members],
  );
  // The same read and cache key as `useAccountAgent`, one per member.
  const profiles = useQueries({
    queries: members.map((pubkey) => ({
      queryKey: ["launchpad", "account-agent", relay, pubkey],
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      queryFn: () => readAccountAgent(relay, pubkey),
    })),
  });
  const agents = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    return [
      ...profiles.flatMap((read) => (read.data ? [read.data] : [])),
      ...recentTaskAgents(work.tasks ?? [], now),
    ];
  }, [profiles, work.tasks]);
  const owners = operatorsOf(agents);
  const names = useUserNames(owners);
  const line = agentWorkLine(
    agents,
    owners.map((owner) => names(owner)),
  );
  if (!line) return null;
  return (
    <p className="text-sm" data-testid="agent-work-note">
      {line}
    </p>
  );
}
