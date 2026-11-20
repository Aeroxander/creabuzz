/**
 * Your Shares on You, across projects (it replaces the old backing receipts): each project whose record lists this account as
 * a holder, with what the account holds and what taking out would give now, read from the chain; and the account's own history
 * of Backs and Take outs kept in this browser. A project's own Money tab is where Back and Take out are.
 */
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PiggyBank } from "lucide-react";
import { Card } from "../../ui/card";
import { dayText, holdingHint, type ProjectNumbers } from "../money/numbers";
import {
  chainKeyOfProject,
  matchNumbers,
  useRecentNumbers,
  useWalletAddress,
} from "../money/use-money";
import { useHomeProjects } from "../home/use-home";
import { type Project, projectRef } from "../project/project-record";
import { NotesCard } from "../tasks/chain/holder/NotesSection";
import { ownSteps, tookOutHere } from "./own-history";
import {
  exactDollarsText,
  NOT_A_RETURN,
  PLAY_MONEY_WORDS,
  sharesWords,
  smallDollarsText,
} from "./pot-words";
import { targetOf } from "./target";
import { type Ready, WalletGate } from "./use-pot";
import { readHolding } from "./YourShares";

/** You reads up to 3 pages of 100 records of numbers, newest first. */
const PAGES = 3;

function Row({
  project,
  numbers,
  ready,
}: {
  project: Project;
  numbers: ProjectNumbers;
  ready: Ready;
}) {
  const target = targetOf(numbers);
  const reading = useQuery({
    queryKey: ["pot", "holding", target.treasury, ready.address],
    staleTime: 10_000,
    retry: false,
    queryFn: () => readHolding(ready, target),
  });
  const held = reading.data;
  return (
    <div className="flex flex-col gap-1 py-2" data-testid="your-shares-row">
      <Link
        className="link min-h-11 font-semibold"
        params={{ ref: projectRef(project) }}
        to="/p/$ref"
      >
        {project.name}
      </Link>
      {reading.isPending ? (
        <p className="text-sm text-muted">Reading what you hold…</p>
      ) : reading.isError || !held ? (
        <p className="text-sm text-muted" data-testid="your-shares-row-failed">
          What you hold here could not be read now. Your money is not affected.
        </p>
      ) : held.shares === 0n && (held.teamShares ?? 0n) === 0n ? (
        <p className="text-sm text-muted">You hold nothing here now.</p>
      ) : (
        <p className="text-sm">
          <span className="num font-semibold" data-testid="your-shares-held">
            {sharesWords(held.shares)} Shares
          </span>
          {held.quote ? (
            <>
              {" "}
              · taking out now gives{" "}
              <span className="num" data-testid="your-shares-cash">
                {smallDollarsText(held.quote.cashNow)} dollars
              </span>
            </>
          ) : null}
        </p>
      )}
    </div>
  );
}

function Inner({ address }: { address: string }) {
  const recent = useRecentNumbers(true, PAGES);
  const projects = useHomeProjects();
  if (recent.isPending || projects.isPending)
    return <Card className="h-20 animate-pulse" />;
  const matched = matchNumbers(projects.data ?? [], recent.data?.events ?? []);
  const holds = matched.filter(
    ({ numbers }) => holdingHint(numbers, [address]).listed,
  );
  const certain =
    recent.data?.complete === true &&
    matched.every(({ numbers }) => holdingHint(numbers, [address]).certain);
  const names = new Map(
    matched.map(({ project }) => [
      chainKeyOfProject(project) ?? "",
      project.name,
    ]),
  );
  const steps = ownSteps(address).slice(0, 10);
  // Projects where this account may be owed money from a task: it holds Shares there, took out from this browser, or the
  // server's rows list it. What it is owed is read from the network (a person who took out holds no Shares).
  const me = address.toLowerCase();
  const owing = matched.filter(({ numbers }) => {
    if (typeof numbers.tasks !== "object" || !numbers.tasks) return false;
    return (
      holdingHint(numbers, [address]).listed ||
      tookOutHere(address, numbers.key) ||
      numbers.tasks.list.some((row) =>
        row.notes?.holders.some((h) => h.account === me),
      )
    );
  });
  return (
    <div className="flex flex-col gap-3">
      {holds.length === 0 ? (
        <p className="text-sm text-muted" data-testid="your-shares-none">
          {certain
            ? "You hold no Shares in the projects this server lists."
            : "Open a project's Money tab to see what you hold there."}
        </p>
      ) : (
        <div className="divide-y divide-white/10">
          {holds.map(({ project, numbers }) => (
            <WalletGate
              chainId={numbers.chainId}
              key={project.coordinate}
              what="see your Shares"
            >
              {(ready) => (
                <Row numbers={numbers} project={project} ready={ready} />
              )}
            </WalletGate>
          ))}
        </div>
      )}
      <p className="text-sm text-muted">{NOT_A_RETURN}</p>
      {owing.length > 0 ? (
        <section
          aria-labelledby="your-claims-title"
          className="flex flex-col gap-3"
          data-testid="your-claims"
        >
          <h3 className="text-sm font-semibold" id="your-claims-title">
            Money you can claim
          </h3>
          {owing.map(({ project, numbers }) => (
            <NotesCard
              heading={project.name}
              key={project.coordinate}
              numbers={numbers}
              project={project}
              projectKey={numbers.key}
              staged
            />
          ))}
        </section>
      ) : null}
      {steps.length > 0 ? (
        <section
          aria-label="Your Backs and Take outs"
          data-testid="your-history"
        >
          <h3 className="text-sm font-semibold">Your Backs and Take outs</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {steps.map((step) => (
              <li key={step.txHash}>
                {dayText(step.at)}:{" "}
                {step.kind === "back"
                  ? `backed ${names.get(step.project) ?? "a project"} with ${exactDollarsText(BigInt(step.dollars))} dollars and got about ${sharesWords(BigInt(step.shares))} Shares`
                  : `took ${sharesWords(BigInt(step.shares))} ${step.kind === "take-out-team" ? "Team Shares" : "Shares"} out of ${names.get(step.project) ?? "a project"} and got about ${smallDollarsText(BigInt(step.dollars))} dollars`}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted">Kept in this browser.</p>
        </section>
      ) : null}
    </div>
  );
}

/** The "Your Shares" section of You: only where the server turns investing on and the wallet shows an account. */
export default function YourSharesList() {
  const address = useWalletAddress().data ?? null;
  if (!address) return null;
  return (
    <section
      aria-labelledby="your-shares-title"
      className="flex flex-col gap-3"
      data-testid="your-shares-list"
    >
      <h2
        className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted"
        id="your-shares-title"
      >
        <PiggyBank aria-hidden="true" size={16} />
        Your Shares
      </h2>
      <p className="text-sm text-muted">{PLAY_MONEY_WORDS}</p>
      <Inner address={address} />
    </section>
  );
}
