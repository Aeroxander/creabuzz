import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { formatAtomic } from "../lib/amounts";
import {
  encodeAttest,
  encodeBind,
  encodeCallId,
  idLabel,
  nextStep,
  SIGNATURES,
} from "../lib/work";
import type { MandateView } from "../lib/work-read";
import { makeWalletAuctionEffects } from "../lib/wallet-effects";
import type { Launch } from "../models";
import { useConnectedWallet } from "../use-connected-wallet";
import { useWork } from "../use-work";
import { FailureNote, WalletStrip } from "./auction-widgets";

const shares = (wei: bigint) => formatAtomic(wei, 18, { maxFractionDigits: 2 });
const sameAddress = (a: string | null, b: string) =>
  a !== null && a.toLowerCase() === b.toLowerCase();
const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

function chainNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The work a project's DAO has set aside money or Shares for: its budgets, the projects inside them and the claims
 * people have filed. Each claim says what happens to it next and who does it, and the connected wallet gets the
 * button for the step that is theirs (review it, finish it, take the payout, take it on as a project manager).
 *
 * Filing a claim and the DAO's own votes (a new budget, a project, an award) are still command-line steps; the page
 * says so, with the command, rather than offering a form that cannot finish the job.
 */
export function WorkTab({ launch, dao }: { launch: Launch; dao: string }) {
  const wallet = useConnectedWallet();
  const work = useWork(dao, wallet.address);
  const queryClient = useQueryClient();
  const launchChainId = chainNumber(launch.record.chainId);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const gate = !wallet.address
    ? "Connect your wallet to act on a claim."
    : launchChainId !== null &&
        wallet.chainId !== null &&
        wallet.chainId !== launchChainId
      ? `Your wallet is on chain ${wallet.chainId}, but this project is on chain ${launchChainId}. Switch networks in your wallet.`
      : null;

  const send = async (key: string, to: string, data: string) => {
    if (!wallet.wallet || launchChainId === null || gate) return;
    setBusy(key);
    setFailure(null);
    try {
      const effects = makeWalletAuctionEffects({
        provider: wallet.wallet.provider,
        deployer: wallet.wallet.address,
        chainId: launchChainId,
      });
      const receipt = await effects.send({ to, data });
      if (receipt.status !== "success") {
        throw new Error("The network rejected that step, so nothing changed.");
      }
      await queryClient.invalidateQueries({
        queryKey: ["launchpad", "work", dao],
      });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="work-tab">
      <Card className="p-4">
        <h2 className="text-base font-bold">Work</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The DAO can set aside money, Shares or both for work. People file a
          claim for what they did, reviewers check it, and only then is anything
          paid or any Shares awarded.
        </p>
        <WalletStrip testIdPrefix="work" wallet={wallet} />
        {gate && wallet.address ? (
          <p
            className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
            data-testid="work-gate"
            role="status"
          >
            {gate}
          </p>
        ) : null}
      </Card>

      {work.isLoading ? (
        <Card className="p-4 text-sm text-muted-foreground">
          Reading the work from the network…
        </Card>
      ) : work.isError ? (
        <Card className="p-4">
          <FailureNote
            message={`Couldn't read the work from the network: ${work.error instanceof Error ? work.error.message : "unknown error"}`}
            testId="work-error"
          />
          <Button
            className="mt-2"
            onClick={() => void work.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </Card>
      ) : work.data && work.data.mandates.length === 0 ? (
        <Card className="p-4 text-sm" data-testid="work-empty">
          <p>
            Nothing has been set aside for work yet. A work budget is created by
            a vote of the DAO.
          </p>
          <CommandHelp dao={dao} />
        </Card>
      ) : (
        <>
          {work.data?.truncated ? (
            <p className="text-sm text-muted-foreground" role="status">
              This DAO has more work than is shown here. The newest is listed.
            </p>
          ) : null}
          {work.data?.mandates.map((mandate) => (
            <MandateCard
              busy={busy}
              chainTime={work.data?.chainTime ?? 0}
              dao={dao}
              gate={gate}
              key={mandate.address}
              mandate={mandate}
              onSend={send}
              wallet={wallet.address}
            />
          ))}
          <CommandHelp dao={dao} />
        </>
      )}
      {failure ? <FailureNote message={failure} testId="work-failure" /> : null}
    </div>
  );
}

function CommandHelp({ dao }: { dao: string }) {
  return (
    <p className="mt-2 text-xs text-muted-foreground" data-testid="work-help">
      Filing a claim, and the DAO's own votes (a new budget, a project, an
      award), use the command line for now:{" "}
      <code className="break-all">buzz launchpad work --help</code> (DAO{" "}
      <span className="font-mono">{truncatePubkey(dao)}</span>).
    </p>
  );
}

function MandateCard({
  mandate,
  chainTime,
  wallet,
  gate,
  busy,
  onSend,
  dao,
}: {
  mandate: MandateView;
  chainTime: number;
  wallet: string | null;
  gate: string | null;
  busy: string | null;
  onSend: (key: string, to: string, data: string) => Promise<void>;
  dao: string;
}) {
  const { created } = mandate;
  const decimals = mandate.currency?.decimals ?? 18;
  const unit = mandate.currency?.symbol ?? "";
  const money = (units: bigint) =>
    `${formatAtomic(units, decimals, { maxFractionDigits: 2 })} ${unit}`.trim();
  const myProjects = mandate.projects.filter((p) =>
    sameAddress(wallet, p.record.manager),
  );
  return (
    <Card className="p-4" data-testid="work-mandate">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">
          Work budget{" "}
          <span className="font-mono text-xs font-normal text-muted-foreground">
            {truncatePubkey(mandate.address)}
          </span>
        </h3>
        <span className="text-xs text-muted-foreground">
          {mandate.closed ? "Closed" : `Open until ${date(mandate.expiresAt)}`}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {created.shareBudget > 0n ? (
          <>
            <dt className="text-muted-foreground">Shares for work</dt>
            <dd data-testid="work-share-budget">
              {shares(mandate.sharesAllocated)} of {shares(created.shareBudget)}{" "}
              given to projects
            </dd>
          </>
        ) : null}
        {created.budget > 0n ? (
          <>
            <dt className="text-muted-foreground">Money for work</dt>
            <dd>{money(created.budget)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Reviewers</dt>
        <dd>{mandate.quorum} must agree on a claim</dd>
      </dl>

      <h4 className="mt-3 text-sm font-semibold">Projects</h4>
      {mandate.projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No project has been approved in this budget yet.
        </p>
      ) : (
        <ul
          className="mt-1 flex flex-col gap-1 text-sm"
          data-testid="work-projects"
        >
          {mandate.projects.map((project) => (
            <li key={project.id}>
              <span className="font-medium">{idLabel(project.id)}</span>
              <span className="text-muted-foreground">
                {" "}
                · managed by {truncatePubkey(project.record.manager)}
                {project.record.shareBudget > 0n
                  ? ` · ${shares(project.record.sharesAwarded)} of ${shares(project.record.shareBudget)} Shares awarded`
                  : ""}
                {project.record.budget > 0n
                  ? ` · ${money(project.record.reserved)} of ${money(project.record.budget)} reserved`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-3 text-sm font-semibold">Claims</h4>
      {mandate.claims.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nobody has filed a claim yet.
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-2" data-testid="work-claims">
          {mandate.claims.map((claim) => {
            const step = nextStep(claim, chainTime, mandate.challengeWindow);
            const mine = sameAddress(wallet, claim.record.contributor);
            const canReview =
              step.kind === "review" &&
              mandate.walletIsReviewer &&
              !mandate.walletAttested.includes(claim.id) &&
              !mine;
            const label = idLabel(claim.id);
            return (
              <li
                className="rounded-lg border border-black/10 p-2 text-sm dark:border-white/10"
                data-testid="work-claim"
                key={claim.id}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{label}</span>
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid="work-claim-status"
                  >
                    {claim.record.status} · filed by{" "}
                    {truncatePubkey(claim.record.contributor)}
                    {claim.record.amount > 0n
                      ? ` · asks for ${money(claim.record.amount)}`
                      : " · asks to be recognised, not paid"}
                  </span>
                </div>
                <p className="mt-1" data-testid="work-claim-next">
                  {step.text}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {step.kind === "bind" && myProjects.length > 0
                    ? myProjects.map((project) => (
                        <Button
                          data-testid="work-bind"
                          disabled={busy !== null || gate !== null}
                          key={project.id}
                          onClick={() =>
                            void onSend(
                              `bind-${claim.id}`,
                              mandate.address,
                              bindData(
                                project.id,
                                claim.id,
                                claim.record.contributor,
                              ),
                            )
                          }
                          size="sm"
                          type="button"
                        >
                          Take on in {idLabel(project.id)}
                        </Button>
                      ))
                    : null}
                  {canReview ? (
                    <>
                      <Button
                        data-testid="work-approve"
                        disabled={busy !== null || gate !== null}
                        onClick={() =>
                          void onSend(
                            `approve-${claim.id}`,
                            mandate.verifiersAddress,
                            encodeAttest(claim.id, true),
                          )
                        }
                        size="sm"
                        type="button"
                      >
                        Approve
                      </Button>
                      <Button
                        data-testid="work-object"
                        disabled={busy !== null || gate !== null}
                        onClick={() =>
                          void onSend(
                            `object-${claim.id}`,
                            mandate.verifiersAddress,
                            encodeAttest(claim.id, false),
                          )
                        }
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Object
                      </Button>
                    </>
                  ) : null}
                  {step.kind === "settle" ? (
                    <Button
                      data-testid="work-settle"
                      disabled={busy !== null || gate !== null}
                      onClick={() =>
                        void onSend(
                          `settle-${claim.id}`,
                          mandate.claimsAddress,
                          encodeCallId(SIGNATURES.settle, claim.id),
                        )
                      }
                      size="sm"
                      type="button"
                    >
                      Finish it
                    </Button>
                  ) : null}
                  {step.kind === "payout" && mine ? (
                    <Button
                      data-testid="work-payout"
                      disabled={busy !== null || gate !== null}
                      onClick={() =>
                        void onSend(
                          `payout-${claim.id}`,
                          mandate.claimsAddress,
                          encodeCallId(SIGNATURES.payout, claim.id),
                        )
                      }
                      size="sm"
                      type="button"
                    >
                      Take it
                    </Button>
                  ) : null}
                </div>
                {step.kind === "award" ? (
                  <p
                    className="mt-2 text-xs text-muted-foreground"
                    data-testid="work-award-help"
                  >
                    To award Shares, a member opens the vote:{" "}
                    <code className="break-all">
                      buzz launchpad work award --dao {dao} --mandate{" "}
                      {mandate.address} --claim {label} --shares &lt;amount&gt;
                    </code>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function bindData(projectId: string, claimId: string, contributor: string) {
  return encodeBind(projectId, claimId, contributor);
}
