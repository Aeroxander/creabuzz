import { useState } from "react";

import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";

import { parseUnits } from "@creaton/core/launchpad/daoActions.ts";
import { hashText } from "@creaton/core/launchpad/work.ts";
import type { MandateView } from "@creaton/core/launchpad/workRead.ts";
import type { SenderCall } from "@/features/identity/lib/sponsoredSender";
import { agreedTermsUpdateContent } from "../lib/agreed-lane";
import {
  AGREED_SHARE_DECIMALS,
  proposalPlan,
  type CoauthorPart,
} from "../lib/agreed-terms";
import { workTitle } from "../lib/work-titles";
import type { OpenWorkArea } from "../lib/ways-to-help";
import type { Launch } from "../models";
import { usePublishMirror } from "../use-launches";

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/**
 * A work area's manager proposes one exact reward before the effort: the
 * deliverable, the person it names, the exact Share quantity, the work
 * deadline and — when there are coauthors — the split both signatures will
 * fix. The offer is one chain call; its description and the work area's exact
 * words are published beside it, so the person deciding can read them.
 */
export function AgreedProposalForm({
  launch,
  mandate,
  chainTime,
  areas,
  titles,
  wallet,
  gate,
  busy,
  onSendBatch,
  onRefresh,
}: {
  launch: Launch;
  mandate: MandateView;
  chainTime: number;
  areas: readonly OpenWorkArea[];
  titles: ReadonlyMap<string, string>;
  wallet: string | null;
  gate: string | null;
  busy: string | null;
  onSendBatch: (key: string, calls: SenderCall[]) => Promise<boolean>;
  onRefresh: () => void;
}) {
  const publish = usePublishMirror();
  const [opened, setOpened] = useState(false);
  const [areaId, setAreaId] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const [criteriaWords, setCriteriaWords] = useState("");
  const [beneficiary, setBeneficiary] = useState("");
  const [quantity, setQuantity] = useState("");
  const [deadline, setDeadline] = useState("");
  const [coauthors, setCoauthors] = useState<
    { key: string; address: string; percent: string }[]
  >([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [proposed, setProposed] = useState<{
    agreementId: string;
    projectId: string;
    deliverable: string;
    criteriaWords: string;
    recipients: CoauthorPart[];
  } | null>(null);

  const mine = mandate.projects.filter(
    (project) =>
      wallet !== null &&
      project.record.manager.toLowerCase() === wallet.toLowerCase(),
  );
  const project =
    mine.find((p) => p.id.toLowerCase() === areaId.toLowerCase()) ?? null;
  const areaWords =
    areas.find(
      (area) =>
        area.mandate === mandate.address.toLowerCase() &&
        area.id.toLowerCase() === areaId.toLowerCase(),
    )?.words ?? null;

  const publishTerms = async (offer: NonNullable<typeof proposed>) => {
    await publish.mutateAsync({
      kind: KIND_LAUNCH_UPDATE,
      author: launch.record.author,
      launchId: launch.record.id,
      content: agreedTermsUpdateContent({
        agreementId: offer.agreementId,
        mandate: mandate.address,
        projectId: offer.projectId,
        deliverable: offer.deliverable,
        criteriaWords: offer.criteriaWords,
        recipients: offer.recipients,
      }),
    });
  };

  const retryPublish = async () => {
    if (!proposed) return;
    setProblem(null);
    try {
      await publishTerms(proposed);
      setProposed(null);
      setOpened(false);
      onRefresh();
    } catch {
      setProblem(
        "Still could not publish the offer's description. The offer itself is saved on the network. Press again to publish the words.",
      );
    }
  };

  const propose = async () => {
    setProblem(null);
    if (!project) {
      setProblem("Pick the work area this offer belongs to.");
      return;
    }
    if (hashText(criteriaWords) !== project.record.checkHash.toLowerCase()) {
      setProblem(
        "Those are not the work area's exact words, so the offer would be judged against something else. Copy them exactly from the work area.",
      );
      return;
    }
    let shares: bigint;
    try {
      shares = parseUnits(
        quantity,
        AGREED_SHARE_DECIMALS,
        "quantity",
        "The reward",
      );
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : "Check the quantity.",
      );
      return;
    }
    const end = deadline
      ? Math.floor(new Date(`${deadline}T23:59:59`).getTime() / 1000)
      : Number.NaN;
    if (!Number.isFinite(end)) {
      setProblem("Pick the date the first submission is due.");
      return;
    }
    const parts: CoauthorPart[] = [];
    for (const part of coauthors) {
      const percent = Number(part.percent);
      if (part.address.trim() === "" && part.percent.trim() === "") {
        continue;
      }
      if (!Number.isInteger(percent) || percent < 1 || percent > 99) {
        setProblem("Each coauthor's part is a whole percent, 1 to 99.");
        return;
      }
      parts.push({ address: part.address, percentBps: percent * 100 });
    }
    const plan = proposalPlan({
      mandate: mandate.address,
      projectId: project.id,
      manager: project.record.manager,
      projectExpiresAt: project.record.expiresAt,
      now: chainTime,
      beneficiary,
      shares,
      workDeadline: BigInt(end),
      deliverable,
      policyRef: `0x${mandate.verifiersAddress.slice(2).toLowerCase().padStart(64, "0")}`,
      coauthors: parts,
    });
    if (plan.kind === "problem") {
      setProblem(plan.problem);
      return;
    }
    const sent = await onSendBatch(
      `propose-agreement-${plan.agreementId.toLowerCase()}`,
      [plan.call],
    );
    if (!sent) {
      setProblem(
        "The offer did not reach the network. No Shares are set aside and nobody is committed. Press again to send it.",
      );
      return;
    }
    const offer = {
      agreementId: plan.agreementId,
      projectId: project.id,
      deliverable: deliverable.trim(),
      criteriaWords,
      recipients: parts,
    };
    try {
      await publishTerms(offer);
    } catch (error) {
      // The offer is on the chain; only the words are missing. Close the form so
      // the pending-publish panel (which lives on the closed card) is the thing
      // on screen, with its "Publish the words again" button reachable. The
      // reason is carried through: "could not publish" alone leaves the manager
      // with nothing to act on.
      setProposed(offer);
      setProblem(
        `The offer is saved on the network, but its description and the work area's words could not be published (${
          error instanceof Error ? error.message : String(error)
        }). Until they are, the person it names cannot read what it is for. Press Publish the words again.`,
      );
      setOpened(false);
      return;
    }
    setOpened(false);
    setDeliverable("");
    setBeneficiary("");
    setQuantity("");
    setDeadline("");
    setCoauthors([]);
    onRefresh();
  };

  if (mine.length === 0) return null;
  const blocked = busy !== null || gate !== null;

  // The offer is already on the chain; only its words are missing. This panel
  // has to be reachable whether or not the form is open, so it is rendered in
  // both states rather than only on the closed card.
  const pendingPanel = proposed ? (
    <div className="mt-2" data-testid="agreed-proposal-pending-publish">
      <p className="text-sm text-amber-800 dark:text-amber-200">
        The offer is saved on the network, but its description and the work
        area's words are not published yet, so the person it names cannot read
        what it is for.
      </p>
      <Button
        className="mt-2"
        data-testid="agreed-proposal-publish"
        disabled={blocked}
        onClick={() => void retryPublish()}
        size="sm"
        type="button"
      >
        Publish the words again
      </Button>
      {problem ? (
        <p
          className="mt-2 text-sm text-red-700 dark:text-red-300"
          data-testid="agreed-proposal-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </div>
  ) : null;

  if (!opened) {
    return (
      <Card className="p-4" data-testid="agreed-proposal-closed">
        <h3 className="text-sm font-semibold">Propose an agreed reward</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Promise an exact number of Shares for one deliverable before the work
          starts. The person you name accepts, and the Shares are set aside
          then, not before.
        </p>
        <Button
          className="mt-2"
          data-testid="agreed-proposal-open"
          onClick={() => setOpened(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          Open the form
        </Button>
        {pendingPanel}
      </Card>
    );
  }

  return (
    <Card className="p-4" data-testid="agreed-proposal-form">
      <h3 className="text-sm font-semibold">Propose an agreed reward</h3>
      {pendingPanel}
      <div className="mt-2 grid gap-2 text-sm">
        <label className="grid gap-1">
          <span className="font-medium">Work area</span>
          <select
            className="w-fit rounded-md border border-input bg-transparent px-2 py-1"
            data-testid="agreed-proposal-area"
            onChange={(event) => {
              setAreaId(event.target.value);
              const words =
                areas.find(
                  (area) =>
                    area.mandate === mandate.address.toLowerCase() &&
                    area.id.toLowerCase() === event.target.value.toLowerCase(),
                )?.words ?? null;
              setCriteriaWords(words ?? "");
              setProblem(null);
            }}
            value={areaId}
          >
            <option value="">Choose a work area</option>
            {mine.map((p) => (
              <option key={p.id} value={p.id}>
                {workTitle(p.id, titles)}
              </option>
            ))}
          </select>
          {project ? (
            <span className="text-xs text-muted-foreground">
              This work area ends {date(project.record.expiresAt)}; the work
              deadline must be before that.
            </span>
          ) : null}
        </label>
        <label className="grid gap-1" htmlFor="agreed-proposal-deliverable">
          <span className="font-medium">The deliverable</span>
          <Input
            data-testid="agreed-proposal-deliverable"
            id="agreed-proposal-deliverable"
            onChange={(event) => setDeliverable(event.target.value)}
            placeholder="e.g. The first guide, finished and reviewed"
            value={deliverable}
          />
          <span className="text-xs text-muted-foreground">
            One deliverable, one offer. Its exact words tie this offer to that
            one piece of work.
          </span>
        </label>
        <label className="grid gap-1">
          <span className="font-medium">What finished work looks like</span>
          <textarea
            className="min-h-16 rounded-md border border-input bg-transparent p-1.5 text-sm"
            data-testid="agreed-proposal-criteria"
            onChange={(event) => setCriteriaWords(event.target.value)}
            placeholder="The work area's exact words"
            value={criteriaWords}
          />
          <span className="text-xs text-muted-foreground">
            {areaWords && areaWords === criteriaWords
              ? "These are the work area's published words, checked against the network."
              : "These must be the work area's exact words. The offer is judged against them."}
          </span>
        </label>
        <label className="grid gap-1" htmlFor="agreed-proposal-beneficiary">
          <span className="font-medium">The person this offer names</span>
          <Input
            data-testid="agreed-proposal-beneficiary"
            id="agreed-proposal-beneficiary"
            onChange={(event) => setBeneficiary(event.target.value)}
            placeholder="Their account address"
            value={beneficiary}
          />
        </label>
        <label className="grid gap-1" htmlFor="agreed-proposal-quantity">
          <span className="font-medium">Exact quantity of Shares</span>
          <Input
            data-testid="agreed-proposal-quantity"
            id="agreed-proposal-quantity"
            inputMode="decimal"
            onChange={(event) => setQuantity(event.target.value)}
            placeholder="e.g. 12.5"
            value={quantity}
          />
          <span className="text-xs text-muted-foreground">
            The exact amount promised. It is not a cash value and not a
            percentage of the project.
          </span>
        </label>
        <label className="grid gap-1" htmlFor="agreed-proposal-deadline">
          <span className="font-medium">The first submission is due by</span>
          <Input
            data-testid="agreed-proposal-deadline"
            id="agreed-proposal-deadline"
            max={
              project
                ? new Date(project.record.expiresAt * 1000)
                    .toISOString()
                    .slice(0, 10)
                : undefined
            }
            onChange={(event) => setDeadline(event.target.value)}
            type="date"
            value={deadline}
          />
        </label>
        <details className="text-sm" data-testid="agreed-proposal-split">
          <summary className="cursor-pointer font-medium">
            Share it with coauthors (optional)
          </summary>
          <p className="mt-1 text-xs text-muted-foreground">
            Leave this empty and the person named above receives the whole
            quantity. Parts are fixed once both sides approve, and cannot be
            added to later.
          </p>
          <div className="mt-2 grid gap-2">
            {coauthors.map((part, index) => (
              <div className="flex flex-wrap items-end gap-2" key={part.key}>
                <label
                  className="grid flex-1 gap-1 text-xs"
                  htmlFor={`agreed-proposal-coauthor-${part.key}`}
                >
                  Coauthor {index + 1} account address
                  <Input
                    data-testid={`agreed-proposal-coauthor-${index}`}
                    id={`agreed-proposal-coauthor-${part.key}`}
                    onChange={(event) =>
                      setCoauthors((current) =>
                        current.map((row, i) =>
                          i === index
                            ? { ...row, address: event.target.value }
                            : row,
                        ),
                      )
                    }
                    value={part.address}
                  />
                </label>
                <label
                  className="grid w-24 gap-1 text-xs"
                  htmlFor={`agreed-proposal-coauthor-part-${part.key}`}
                >
                  Part (%)
                  <Input
                    data-testid={`agreed-proposal-coauthor-part-${index}`}
                    id={`agreed-proposal-coauthor-part-${part.key}`}
                    inputMode="numeric"
                    onChange={(event) =>
                      setCoauthors((current) =>
                        current.map((row, i) =>
                          i === index
                            ? { ...row, percent: event.target.value }
                            : row,
                        ),
                      )
                    }
                    value={part.percent}
                  />
                </label>
                <Button
                  onClick={() =>
                    setCoauthors((current) =>
                      current.filter((_, i) => i !== index),
                    )
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Remove
                </Button>
              </div>
            ))}
            {coauthors.length < 3 ? (
              <Button
                className="w-fit"
                data-testid="agreed-proposal-add-coauthor"
                onClick={() =>
                  setCoauthors((current) => [
                    ...current,
                    {
                      key: crypto.randomUUID(),
                      address: "",
                      percent: "",
                    },
                  ])
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Add a coauthor
              </Button>
            ) : null}
          </div>
        </details>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {proposed ? (
          <Button
            data-testid="agreed-proposal-publish"
            disabled={blocked}
            onClick={() => void retryPublish()}
            size="sm"
            type="button"
          >
            Publish the words again
          </Button>
        ) : (
          <Button
            data-testid="agreed-proposal-send"
            disabled={blocked}
            onClick={() => void propose()}
            size="sm"
            type="button"
          >
            Propose these terms
          </Button>
        )}
        <Button
          data-testid="agreed-proposal-cancel"
          disabled={busy !== null}
          onClick={() => {
            setOpened(false);
            setProblem(null);
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Close
        </Button>
      </div>
      {problem ? (
        <p
          className="mt-2 text-sm text-red-700 dark:text-red-300"
          data-testid="agreed-proposal-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </Card>
  );
}
