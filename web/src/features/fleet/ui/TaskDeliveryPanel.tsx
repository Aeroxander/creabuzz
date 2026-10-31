import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useLaunches } from "@/features/launchpad/use-launches";
import { launchCoordinate } from "@/features/launchpad/models";
import { daoOfLaunch } from "@/features/launchpad/lib/dao-of-launch";
import { ethChainId, getRpcEndpoint } from "@/features/launchpad/chain";
import { claimStatusLabel } from "@creaton/core/launchpad/work.ts";
import { workQuery } from "@/features/launchpad/use-work";
import { useWalletLabels } from "@/features/launchpad/use-wallet-labels";
import { Button } from "@/shared/ui/button";
import { failureWords } from "@/shared/lib/readable-error";
import { outputUrl, type TaskDelivery } from "../lib/task-delivery";
import type { WorkItem } from "../use-work-board";

/** One task's delivery and funding context. Saving references is never a financial action. */
export function TaskDeliveryPanel({
  item,
  onSave,
}: {
  item: WorkItem;
  onSave: (delivery: TaskDelivery | null) => Promise<void>;
}) {
  const launches = useLaunches();
  const [project, setProject] = useState(item.delivery?.project ?? "");
  const [output, setOutput] = useState(item.delivery?.output ?? "");
  const [claimKey, setClaimKey] = useState(
    item.delivery?.claim
      ? `${item.delivery.claim.mandate}:${item.delivery.claim.id}`
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const launch = launches.data?.find(
    (l) => launchCoordinate(l.record.author, l.record.id) === project,
  );
  const endpoint = getRpcEndpoint();
  const chain = useQuery({
    queryKey: ["task-delivery", "chain", endpoint],
    queryFn: () => ethChainId(endpoint),
    enabled: Boolean(launch && daoOfLaunch(launch)),
    staleTime: 10_000,
    retry: 1,
  });
  const correctChain =
    launch &&
    chain.data !== undefined &&
    String(chain.data) === launch.record.chainId;
  const workOptions = workQuery(
    correctChain && launch ? daoOfLaunch(launch) : null,
    null,
  );
  const work = useQuery({
    ...workOptions,
    queryKey: [
      ...workOptions.queryKey,
      "task-delivery",
      endpoint,
      launch?.record.chainId,
    ],
    placeholderData: undefined,
  });
  const claims = (work.data?.mandates ?? []).flatMap((m) =>
    m.claims.map((c) => ({
      key: `${m.address.toLowerCase()}:${c.id.toLowerCase()}`,
      claim: c,
      mandate: m.address,
    })),
  );
  const selected = claims.find((c) => c.key === claimKey);
  const walletLabel = useWalletLabels(
    selected ? [selected.claim.record.contributor] : [],
  );
  const save = async () => {
    setMessage(null);
    const url = output.trim() ? outputUrl(output) : null;
    if (output.trim() && !url) {
      setMessage("Use an http or https link for the output.");
      return;
    }
    if (project && !launch) {
      setMessage(
        "This project could not be found. Retry the project read or choose another project.",
      );
      return;
    }
    if (!project && (url || claimKey)) {
      setMessage("Choose a project for these delivery references.");
      return;
    }
    setBusy(true);
    try {
      const original =
        item.delivery?.project === project &&
        item.delivery.claim &&
        `${item.delivery.claim.mandate}:${item.delivery.claim.id}` === claimKey
          ? item.delivery.claim
          : null;
      if (claimKey && !selected && !original)
        throw new Error("Read the project's claims before linking one.");
      await onSave(
        project
          ? {
              project,
              output: url,
              claim: selected
                ? {
                    id: selected.claim.id.toLowerCase(),
                    mandate: selected.mandate.toLowerCase(),
                  }
                : original,
            }
          : null,
      );
      setMessage("Delivery links saved. No payment was sent.");
    } catch (error) {
      setMessage(failureWords(error).text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="mt-3 space-y-2 rounded-lg border border-border p-3"
      aria-label="Delivery and payment links"
      data-testid="task-delivery"
    >
      <h4 className="text-sm font-semibold">Delivery & payment</h4>
      <p className="text-xs text-muted-foreground">
        Link the project, its output and an existing funding claim. Finishing or
        approving this task never sends money. A reference does not establish
        that a claim was filed for this task or approved by the project.
      </p>
      <label className="block text-xs">
        Project
        <select
          className="mt-1 w-full rounded border border-input bg-background p-2 text-sm"
          value={project}
          disabled={busy}
          onChange={(e) => {
            setProject(e.target.value);
            setClaimKey("");
            setMessage(null);
          }}
          data-testid="task-delivery-project"
        >
          <option value="">No linked project</option>
          {project && !launch ? (
            <option value={project}>
              Previously linked project (not loaded)
            </option>
          ) : null}
          {(launches.data ?? []).map((l) => (
            <option
              key={launchCoordinate(l.record.author, l.record.id)}
              value={launchCoordinate(l.record.author, l.record.id)}
            >
              {l.record.name}
            </option>
          ))}
        </select>
      </label>
      {launches.isError ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void launches.refetch()}
        >
          Retry projects
        </Button>
      ) : null}
      <label className="block text-xs">
        Output or evidence link
        <input
          className="mt-1 w-full rounded border border-input bg-background p-2 text-sm"
          type="url"
          value={output}
          disabled={busy}
          onChange={(e) => setOutput(e.target.value)}
          placeholder="https://…"
          data-testid="task-delivery-output"
        />
      </label>
      {launch && daoOfLaunch(launch) ? (
        <>
          <label className="block text-xs">
            Onchain claim
            <select
              className="mt-1 w-full rounded border border-input bg-background p-2 text-sm"
              value={claimKey}
              disabled={busy || !correctChain || work.isPending || work.isError}
              onChange={(e) => setClaimKey(e.target.value)}
              data-testid="task-delivery-claim"
            >
              <option value="">No linked claim</option>
              {claimKey && !selected ? (
                <option value={claimKey}>
                  Previously linked claim (not read yet)
                </option>
              ) : null}
              {claims.map((c) => (
                <option key={c.key} value={c.key}>
                  {claimStatusLabel(c.claim.record)} · claim{" "}
                  {c.claim.id.slice(0, 10)}… · budget {c.mandate.slice(0, 10)}…
                </option>
              ))}
            </select>
          </label>
          {!correctChain ? (
            <p className="text-xs text-muted-foreground">
              {chain.isPending
                ? "Checking the selected network…"
                : `Select this project's network (${launch.record.chainId ?? "unknown"}) to read its claims.`}
            </p>
          ) : null}
          {work.isError || chain.isError ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void chain.refetch();
                if (correctChain) void work.refetch();
              }}
            >
              Retry claim read
            </Button>
          ) : null}
          {selected ? (
            <p className="text-xs" data-testid="task-delivery-status">
              Read from the chain: {claimStatusLabel(selected.claim.record)} ·
              filed by {walletLabel(selected.claim.record.contributor)}. Review
              and payment remain separate actions.
            </p>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={busy || launches.isPending}
          onClick={() => void save()}
          data-testid="task-delivery-save"
        >
          {busy ? "Saving…" : "Save delivery links"}
        </Button>
        {launch ? (
          <Link
            className="text-sm underline"
            to="/launchpad/$launchId"
            params={{ launchId: launch.record.id }}
            search={{
              author: launch.record.author,
              tab: claimKey ? "work" : undefined,
              claim:
                selected?.claim.id ??
                (project === item.delivery?.project
                  ? item.delivery.claim?.id
                  : undefined),
              mandate:
                selected?.mandate ??
                (project === item.delivery?.project
                  ? item.delivery.claim?.mandate
                  : undefined),
            }}
          >
            Open project{claimKey ? " claim" : ""}
          </Link>
        ) : null}
        {item.delivery?.output ? (
          <a
            className="text-sm underline"
            href={item.delivery.output}
            target="_blank"
            rel="noreferrer"
          >
            Open saved output
          </a>
        ) : null}
      </div>
      {message ? (
        <p className="text-xs" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
