/**
 * Launch a project: the founder's two numbers (the daily allowance and the Team pool) with their defaults, what each means
 * for a backer, the limits every project has, what cannot be changed later, and one press that sends one call. The
 * Launcher's settings hash is read when the sheet opens and again just before the press; if it moved, nothing is sent and the
 * sheet says so and shows the new settings. The call is made from exactly the two numbers and the hash on the sheet.
 */
import { readLaunchOffer } from "@creaton/core/pot/pot-state.ts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Field } from "../../ui/field";
import type { Project } from "../project/project-record";
import { PotSheet } from "../pot/PotSheet";
import type { Ready } from "../pot/use-pot";
import { isLaunched } from "./launch-read";
import { launchIdentity, sharesName, sharesSymbol } from "./launch-ids";
import { launchCallFor } from "./launch-plan";
import {
  afterLaunch,
  allowanceForBackers,
  DEFAULT_LAUNCH_DRAFT,
  fixedLimits,
  type LaunchDraft,
  launchTermsSentence,
  poolForBackers,
  readLaunchTerms,
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
  const [draft, setDraft] = useState<LaunchDraft>(DEFAULT_LAUNCH_DRAFT);
  const offer = useQuery({
    queryKey: ["pot", "launch-offer", launcher],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => readLaunchOffer(ready.read, launcher),
  });
  const terms = offer.data ? readLaunchTerms(draft, offer.data) : null;
  const name = sharesName(project.name);
  const { key } = launchIdentity(project, ready.address);
  const call =
    offer.data && terms?.ok
      ? launchCallFor({
          launcher,
          project,
          founder: ready.address,
          terms,
          offer: offer.data,
        })
      : null;
  const shown = offer.data;
  const set = (field: keyof LaunchDraft) => (value: string) =>
    setDraft((d) => ({ ...d, [field]: value }));
  return (
    <PotSheet
      account={ready.address}
      action={`launch:${chainId}:${launcher}:${project.coordinate}`}
      blocked={!call}
      calls={call ? [call] : null}
      chainId={chainId}
      confirmLabel={`Launch ${project.name}`}
      description="Put it on the network so people can back it"
      detail={terms?.ok ? `${terms.ratePpm}:${terms.teamPool}` : undefined}
      done="It is on the network. Tying your page to it now."
      doneEarlier="Your earlier launch is on the network, with the numbers you chose then. They cannot be changed now. Nothing new was sent."
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
            Creaton's settings could not be read from the network, so nothing
            can be sent now. Nothing changed.
          </p>
          <Button onClick={() => void offer.refetch()} variant="secondary">
            Try again
          </Button>
        </div>
      ) : (
        <>
          <p className="text-sm">
            You choose two numbers. Everything else is the same for every
            project.
          </p>
          <Field
            autoComplete="off"
            data-testid="launch-rate"
            hint="Percent of the project's money the team may draw a day. The start is 0.10."
            inputMode="decimal"
            label="Daily allowance, percent a day"
            onChange={(e) => set("rate")(e.target.value)}
            problem={terms && !terms.ok ? terms.rate : null}
            value={draft.rate}
          />
          {terms?.ok ? (
            <p className="text-sm text-muted" data-testid="launch-rate-words">
              {allowanceForBackers(terms.ratePpm)}
            </p>
          ) : null}
          <Field
            autoComplete="off"
            data-testid="launch-pool"
            hint="Team Shares set aside for the people who build this. The start is 10,000,000."
            inputMode="numeric"
            label="Team pool, Team Shares"
            onChange={(e) => set("pool")(e.target.value)}
            problem={terms && !terms.ok ? terms.pool : null}
            value={draft.pool}
          />
          {terms?.ok ? (
            <p className="text-sm text-muted" data-testid="launch-pool-words">
              {poolForBackers(terms.teamPool)}
            </p>
          ) : null}
          <section
            aria-labelledby="launch-same-title"
            className="flex flex-col gap-1.5"
            data-testid="launch-limits"
          >
            <h3 className="text-sm font-semibold" id="launch-same-title">
              The same for every project
            </h3>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted">
              {fixedLimits(shown).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
          <section
            aria-labelledby="launch-later-title"
            className="flex flex-col gap-1.5"
            data-testid="launch-later"
          >
            <h3 className="text-sm font-semibold" id="launch-later-title">
              After you launch
            </h3>
            <p className="text-sm text-muted">{afterLaunch(shown).cannot}</p>
            <p className="text-sm text-muted">{afterLaunch(shown).can}</p>
          </section>
          {terms?.ok ? (
            <p className="text-sm" data-testid="launch-terms">
              {launchTermsSentence(project.name, terms)} Its Shares will be
              named {name} ({sharesSymbol(project.name)}). You sign once.
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
