import type { Launch } from "@/features/launchpad/launchpadModels";

const KIND_STYLES: Record<string, string> = {
  "futarchy-budget": "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  plain: "bg-muted text-muted-foreground",
  signal: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
};

export function LaunchProposalsPanel({ launch }: { launch: Launch }) {
  if (launch.proposals.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        <p>No proposals yet.</p>
        <p className="mt-1">
          Signal proposals live as git issues; budget and membership proposals
          go onchain after graduation. Futarchy markets resolve budget and
          subDAO allocation only.
        </p>
      </div>
    );
  }
  return (
    <ol className="flex max-w-2xl flex-col gap-2">
      {launch.proposals.map((proposal) => (
        <li
          key={proposal.id}
          className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3"
        >
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-2xs font-medium uppercase tracking-wide ${KIND_STYLES[proposal.kind] ?? KIND_STYLES.plain}`}
            >
              {proposal.kind === "futarchy-budget"
                ? "Futarchy · budget"
                : proposal.kind}
            </span>
            <span className="text-2xs uppercase tracking-wide text-muted-foreground">
              {proposal.state}
            </span>
          </div>
          <h4 className="mt-1 text-sm font-semibold">{proposal.title}</h4>
          {proposal.issue ? (
            <p className="mt-1 font-mono text-2xs text-muted-foreground">
              Issue: {proposal.issue}
            </p>
          ) : null}
          {proposal.proposalId ? (
            <p className="mt-0.5 font-mono text-2xs text-muted-foreground">
              Onchain: {proposal.proposalId}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
