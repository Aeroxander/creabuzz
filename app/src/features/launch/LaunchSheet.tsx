/**
 * Launch a project: the two starting numbers every project has (the daily allowance and the Team pool; nothing is typed), the
 * limits every project has, what cannot be changed later, and one press that sends one call. The Launcher's settings hash is
 * read when the sheet opens and again just before the press; if it moved, nothing is sent and the sheet says so and shows the
 * new settings. The call is made from exactly the two numbers and the hash on the sheet.
 */
import { readLaunchOffer } from "@creaton/core/pot/pot-state.ts";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import type { Project } from "../project/project-record";
import { PotSheet } from "../pot/PotSheet";
import type { Ready } from "../pot/use-pot";
import { isLaunched } from "./launch-read";
import { launchIdentity } from "./launch-ids";
import { launchCallFor } from "./launch-plan";
import {
  feeSentence,
  launchTermsFor,
  launchTermsSentence,
  SETTINGS_MOVED_WORDS,
} from "./launch-terms";

interface Props {
  project: Project;
  ready: Ready;
  chainId: number;
  launcher: string;
  playMoney: boolean;
  open: boolean;
  onClose: () => void;
  /** Runs once the launch landed, with the key it was launched under. */
  onLanded: (key: string) => void;
}

export function LaunchSheet({
  project,
  ready,
  chainId,
  launcher,
  playMoney,
  open,
  onClose,
  onLanded,
}: Props) {
  const offer = useQuery({
    queryKey: ["pot", "launch-offer", launcher],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => readLaunchOffer(ready.read, launcher),
  });
  const terms = offer.data ? launchTermsFor(offer.data) : null;
  const { key } = launchIdentity(project, ready.address);
  const call =
    offer.data && terms
      ? launchCallFor({
          launcher,
          project,
          founder: ready.address,
          terms,
          offer: offer.data,
        })
      : null;
  const shown = offer.data;
  return (
    <PotSheet
      account={ready.address}
      action={`launch:${chainId}:${launcher}:${project.coordinate}`}
      blocked={!call}
      calls={call ? [call] : null}
      chainId={chainId}
      confirmLabel={`Launch ${project.name}`}
      detail={terms ? `${terms.ratePpm}:${terms.teamPool}` : undefined}
      done="It is on the network. Tying your page to it now."
      doneEarlier="Your earlier launch is on the network. Its numbers cannot be changed now. Nothing new was sent."
      landed={(wallet) =>
        isLaunched((to, data) => wallet.readCall(to, data), launcher, key)
      }
      lookLabel="Look for your launch"
      onLanded={() => onLanded(key)}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
      playMoney={playMoney}
      problemAction="launch"
      recheck={async () => {
        const now = await readLaunchOffer(ready.read, launcher);
        if (shown && now.settingsHash === shown.settingsHash) return null;
        // The sheet shows the new settings from here on; the words below say why nothing was sent.
        await offer.refetch();
        return SETTINGS_MOVED_WORDS;
      }}
      testId="launch-sheet"
      title={`Launch ${project.name}`}
    >
      {offer.isPending ? (
        <Card className="h-24 animate-pulse" />
      ) : offer.isError || !shown ? (
        <div className="flex flex-col gap-2" data-testid="launch-read-failed">
          <p className="text-sm">
            Creaton's settings could not be read, so nothing was sent.
          </p>
          <Button onClick={() => void offer.refetch()} variant="secondary">
            Try again
          </Button>
        </div>
      ) : (
        <>
          {terms ? (
            <p className="text-sm" data-testid="launch-terms">
              {launchTermsSentence(terms)}
            </p>
          ) : (
            <p className="text-sm" data-testid="launch-over-ceiling">
              Creaton's limits are under the starting numbers right now, so
              nothing can be sent.
            </p>
          )}
          {feeSentence(shown.feeBps) ? (
            <p className="text-sm" data-testid="launch-fee">
              {feeSentence(shown.feeBps)}
            </p>
          ) : null}
          <details className="text-sm text-muted">
            <summary className="cursor-pointer">Technical details</summary>
            <p className="mt-1.5 break-all" data-testid="launch-fingerprint">
              Settings fingerprint {shown.settingsHash}. The launch is refused
              if Creaton's settings change before you sign.
            </p>
          </details>
        </>
      )}
    </PotSheet>
  );
}
