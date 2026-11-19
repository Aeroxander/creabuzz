/**
 * The founder's way to open a project to backers: a card on the project page that explains what launching is and opens the
 * launch sheet. It asks the Launcher (not the server) whether this wallet already launched the project: if it did and the
 * page is not yet tied to it, the only thing offered is the tie ("Finish linking"), never a second launch. Two writes in
 * all (the launch, then the founder's own record naming it); the second can be pressed again until it lands.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { potNetwork } from "../../lib/pot-network";
import { publishAsUser } from "../../lib/relay";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { useToast } from "../../ui/toast";
import { PLAY_MONEY_WORDS } from "../pot/pot-words";
import { type Ready, WalletGate } from "../pot/use-pot";
import type { Project } from "../project/project-record";
import { isLaunched } from "./launch-read";
import { launchIdentity, recordWithLaunch } from "./launch-ids";
import { LaunchSheet } from "./LaunchSheet";

/** Words for a record that could not be written after the launch landed. */
const LINK_FAILED =
  "Your project is on the network, but its page could not be tied to it. Press Finish linking to try again.";

function Inner({
  project,
  ready,
  chainId,
  launcher,
  playMoney,
  onLaunched,
}: {
  project: Project;
  ready: Ready;
  chainId: number;
  launcher: string;
  playMoney: boolean;
  onLaunched?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { key } = launchIdentity(project, ready.address);
  const launched = useQuery({
    queryKey: ["pot", "launched", launcher, key],
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => isLaunched(ready.read, launcher, key),
  });
  const link = useMutation({
    mutationFn: (linked: string) =>
      publishAsUser(recordWithLaunch(project, linked), LINK_FAILED),
    onSuccess: () => {
      toast("Your project is open to backers.", "done");
      onLaunched?.();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["project"] }),
  });
  const finish = (linked: string) => {
    if (link.isPending) return;
    setProblem(null);
    link.mutate(linked, {
      onError: (error) =>
        setProblem(error instanceof Error ? error.message : LINK_FAILED),
    });
  };
  if (launched.isPending)
    return (
      <p className="text-sm text-muted" data-testid="launch-checking">
        Checking the network…
      </p>
    );
  if (launched.isError)
    return (
      <div className="flex flex-col gap-2" data-testid="launch-check-failed">
        <p className="text-sm">
          The network could not be asked whether this project is already
          launched, so nothing can be sent now. Nothing changed.
        </p>
        <Button onClick={() => void launched.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  return (
    <>
      {problem ? (
        <p
          className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
          data-testid="launch-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      {launched.data ? (
        <>
          <p className="text-sm" data-testid="launch-unlinked">
            It is on the network from this wallet. One step is left: tie this
            page to it so backers can see its numbers.
          </p>
          <Button
            block
            data-testid="launch-finish"
            disabled={link.isPending}
            onClick={() => finish(key)}
          >
            {link.isPending ? "Linking…" : "Finish linking"}
          </Button>
        </>
      ) : (
        <>
          <Button block data-testid="launch-open" onClick={() => setOpen(true)}>
            Launch
          </Button>
          <LaunchSheet
            chainId={chainId}
            launcher={launcher}
            onClose={() => setOpen(false)}
            onLanded={(landedKey) => {
              void queryClient.invalidateQueries({ queryKey: ["pot"] });
              finish(landedKey);
            }}
            open={open}
            playMoney={playMoney}
            project={project}
            ready={ready}
          />
        </>
      )}
    </>
  );
}

export function LaunchCard({
  project,
  onLaunched,
}: {
  project: Project;
  onLaunched?: () => void;
}) {
  const titleId = useId();
  const network = potNetwork();
  if (!network) return null;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="launch-card"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        Open {project.name} to backers
      </h2>
      <p className="text-sm">
        Right now this is a page. Launching it lets people back it and take
        their money out any day. You choose two numbers; everything else is the
        same for every project.
      </p>
      <p className="text-sm text-muted" data-testid="launch-play-money">
        {PLAY_MONEY_WORDS}
      </p>
      <WalletGate chainId={network.chainId} what="launch this project">
        {(ready) => (
          <Inner
            chainId={network.chainId}
            launcher={network.launcher}
            onLaunched={onLaunched}
            playMoney={network.playMoney}
            project={project}
            ready={ready}
          />
        )}
      </WalletGate>
    </Card>
  );
}
