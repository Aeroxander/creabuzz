import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { publishAsUser } from "../../lib/relay";
import { investingOn } from "../../lib/server";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { useToast } from "../../ui/toast";
import { OwnershipLine } from "../money/MoneyTab";
import {
  useMoneySend,
  useRecentNumbers,
  useWallet,
  useWalletAddress,
} from "../money/use-money";
import type { Project } from "../project/project-record";
import {
  builtLauncher,
  launcherFromRecord,
  launchIdentity,
  recordWithLaunch,
  sharesName,
  sharesSymbol,
} from "./launch";
import { LAUNCHER_READS, launchCall } from "./team-calls";
import { teamProblem } from "./team-copy";
import { readWord } from "./use-team";

/** Where to launch: the build's Launcher, else the one the server's newest record of numbers names. */
function useLauncher() {
  const built = builtLauncher();
  const recent = useRecentNumbers(built === null, 1).data;
  if (built) return built;
  for (const event of recent?.events ?? []) {
    const found = launcherFromRecord(event.tags);
    if (found) return found;
  }
  return null;
}

/**
 * The founder's one press to put their project on the network, then the record naming it. Two writes: if the second
 * does not go through after the first landed, the launch is found on the network next time and "Finish linking" offers
 * only the second (`projectByKey` is the durable record of what already happened).
 */
export function LaunchProject({ project }: { project: Project }) {
  const where = useLauncher();
  const wallet = useWallet();
  const me = useWalletAddress().data ?? null;
  const toast = useToast();
  const queryClient = useQueryClient();
  const titleId = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const send = useMoneySend(
    `launch:${where?.chainId ?? 0}:${where?.launcher ?? ""}:${project.coordinate}`,
  );
  const identity = me ? launchIdentity(project, me) : null;
  // Already on the network from this wallet (the record does not say so yet): only the link is left to write.
  const onChain = useQuery({
    queryKey: ["team", "launched", where?.launcher ?? "", identity?.key ?? ""],
    enabled:
      investingOn() && Boolean(where && identity && wallet.isAvailable()),
    staleTime: 30_000,
    queryFn: async () => {
      if (!where || !identity) return false;
      const answer = (
        await wallet.readCall(
          where.launcher,
          LAUNCHER_READS.projectByKey(identity.key),
        )
      ).replace(/^0x/, "");
      // Project{founder, shares, ...}: the Shares' address is the second word; zero means not launched.
      return (
        /^[0-9a-fA-F]{128}/.test(answer) &&
        /[1-9a-fA-F]/.test(answer.slice(64, 128))
      );
    },
  });
  const link = useMutation({
    mutationFn: (key: string) =>
      publishAsUser(
        recordWithLaunch(project, key),
        "Your project is on the network, but its page could not be updated. Press Finish linking to try again.",
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["project"] }),
  });
  if (!wallet.isAvailable() || !where) return null;
  const busy = send.isPending || link.isPending;
  const finish = (key: string) =>
    link.mutate(key, {
      onSuccess: () => toast("Your project is on the network.", "done"),
      onError: (error) => setProblem(error.message),
    });
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="launch-project"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        Put {project.name} on the network
      </h2>
      {onChain.data ? (
        <p className="text-sm">
          It is on the network from this wallet. One step is left: tie this page
          to it so backers can see its numbers.
        </p>
      ) : (
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
          <li>
            This creates its 1,000,000,000 Shares, named{" "}
            {sharesName(project.name)} ({sharesSymbol(project.name)}): 20% held
            for you, released over 365 days from the day a market opens; 20% to
            give for work; 15% for backing rounds; 25% for an auction and 10% to
            go beside it in a pool; 10% kept in reserve.
          </li>
          <li>
            Nothing is raised until you open a backing round. Creaton takes 3%
            of the money, and 2% of the Shares if you open a market.
          </li>
          <li>The wallet you use now becomes the project's runner.</li>
        </ul>
      )}
      <OwnershipLine />
      {problem ? (
        <p
          className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
          data-testid="launch-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <Button
        block
        data-testid="launch-press"
        disabled={busy}
        onClick={() => {
          setProblem(null);
          if (onChain.data && identity) return finish(identity.key);
          // The key the launch is sent under, from the account that sends it: the link names exactly that launch.
          let launched: string | null = null;
          send.send(
            {
              chainId: where.chainId,
              build: async (w) => {
                const from = await w.getAddress();
                const { projectId, key } = launchIdentity(project, from);
                launched = key;
                const hash = await readWord(
                  w,
                  where.launcher,
                  LAUNCHER_READS.launchHash(key),
                );
                return [
                  launchCall({
                    launcher: where.launcher,
                    projectId,
                    name: sharesName(project.name),
                    symbol: sharesSymbol(project.name),
                    settingsHash: `0x${hash.toString(16).padStart(64, "0")}`,
                  }),
                ];
              },
            },
            {
              onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: ["team"] });
                if (launched) finish(launched);
              },
              onError: (error) => {
                void queryClient.invalidateQueries({ queryKey: ["team"] });
                setProblem(teamProblem(error, "launch"));
              },
            },
          );
        }}
      >
        {busy
          ? "Waiting…"
          : onChain.data
            ? "Finish linking"
            : send.waiting
              ? "Look for your launch"
              : "Put it on the network"}
      </Button>
    </Card>
  );
}
