/**
 * A DAO's track record: what it holds, what it has paid and to whom, what its team was promised against and has
 * earned, and what happened and when.
 *
 * Anyone can open it; nothing needs a wallet. Every number is read from the network (the same reads the Work and
 * Decisions tabs use, plus the logs in `lib/record-read.ts`), so it matches what the contracts hold and nobody typed it
 * in. What could not be read, or has no date, is said so on the page and never filled in.
 */

import { useState } from "react";
import { toast } from "sonner";

import { useProfiles } from "@/features/profiles/use-profiles";
import { pickUserName } from "@/features/profiles/lib/user-label";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { recordSaleCurrency } from "../chain";
import { formatAtomic } from "../lib/amounts";
import { formatUnits } from "../lib/dao-actions";
import { contractNames } from "../lib/contract-names";
import { hashText } from "../lib/work";
import {
  buildLedger,
  type CurrencyFigures,
  decisionFigures,
  type Labels,
  type LedgerEntry,
  type LedgerKind,
  moneyFigures,
  promiseFigures,
  watchNotes,
  workFigures,
} from "../lib/record";
import { recordUrl } from "../lib/record-link";
import {
  addressesInRecord,
  personLabeler,
  pubkeysToName,
} from "../lib/record-people";
import type { Launch } from "../models";
import { useDaoHoldings } from "../use-dao-holdings";
import { useDecisionContext, useDecisions } from "../use-decisions";
import { usePeopleWithWallets } from "../use-people";
import { useDaoHolders, useRecordEvents, useWork } from "../use-work";
import { bondsOf, decisionTitler } from "./decision-title";
import { Figure } from "./Figure";
import { HoldersCard } from "./HoldersCard";

const PAGE = 15;

const shares = (atomic: bigint): string =>
  formatAtomic(atomic, 18, { maxFractionDigits: 0 });
const day = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

const FILTERS: Array<{ id: "all" | LedgerKind; label: string }> = [
  { id: "all", label: "Everything" },
  { id: "pay", label: "Payments" },
  { id: "work", label: "Work" },
  { id: "milestone", label: "Milestones" },
  { id: "decision", label: "Decisions" },
];

function amount(figures: CurrencyFigures, atomic: bigint): string {
  return `${formatAtomic(atomic, figures.decimals, { maxFractionDigits: 2 })} ${figures.symbol}`;
}

export function RecordTab({
  launch,
  dao,
  onOpen,
}: {
  launch: Launch;
  dao: string;
  /** Go to the tab where a thing in the list lives. */
  onOpen: (tab: "decisions" | "work") => void;
}) {
  const work = useWork(dao, null);
  const decisions = useDecisions(dao, null);
  const context = useDecisionContext(dao);
  const events = useRecordEvents(dao, work.data);
  const holders = useDaoHolders(dao);
  const sale = launch.record.currency
    ? recordSaleCurrency(launch.record)
    : null;
  const holdings = useDaoHoldings({
    dao,
    currency: launch.record.currency ?? null,
    shares: context.data?.shares ?? null,
    wallet: null,
  });
  // Names for the wallets the record mentions: people on this server who bound that wallet to their account.
  const wallets = usePeopleWithWallets();
  const named = pubkeysToName(wallets.data ?? [], [
    ...(work.data && events.data
      ? addressesInRecord(work.data, events.data)
      : []),
    ...(holders.data?.holders.map((h) => h.holder) ?? []),
  ]);
  const profiles = useProfiles(named);
  const labelOf = personLabeler(wallets.data ?? [], (pubkey) =>
    pickUserName(profiles.data?.[pubkey]),
  );
  const [filter, setFilter] = useState<"all" | LedgerKind>("all");
  const [shown, setShown] = useState(PAGE);

  const titleOf = decisionTitler({
    launch,
    dao,
    factory: context.data?.factory,
    mandates: work.data?.mandates.map((m) => m.address),
    bonds: bondsOf(work.data),
    projectToken: context.data?.shares,
  });
  // The launch record carries each milestone's words; the chain only holds their hash, so match them up.
  const milestoneWords = new Map(
    (launch.record.unlocks?.milestones ?? []).map((m) => [
      hashText(m.label).toLowerCase(),
      m.label.trim(),
    ]),
  );
  const labels: Labels = {
    milestone: (checkHash, index) => {
      const words = milestoneWords.get(checkHash.toLowerCase());
      return words
        ? `milestone ${index + 1} (${words})`
        : `milestone ${index + 1}`;
    },
    person: labelOf,
    money: (mandate, atomic) =>
      mandate.currency && !mandate.currency.decimalsKnown
        ? `${atomic.toString()} raw units of ${mandate.currency.symbol}`
        : `${formatAtomic(atomic, mandate.currency?.decimals ?? 18, { maxFractionDigits: 2 })} ${mandate.currency?.symbol ?? ""}`.trim(),
    shares,
    title: titleOf,
  };

  const loading = work.isLoading || decisions.isLoading;
  if (loading) {
    return (
      <Card
        className="p-4 text-sm text-muted-foreground"
        data-testid="record-tab"
      >
        Reading the track record from the network…
      </Card>
    );
  }
  if (!work.data || !decisions.data) {
    return (
      <Card className="p-4 text-sm" data-testid="record-tab">
        Couldn't read this DAO from the network. Try again in a moment.
      </Card>
    );
  }

  const money = moneyFigures(work.data);
  const workCounts = workFigures(work.data);
  const decisionCounts = decisionFigures(decisions.data.decisions);
  const record = events.data;
  const promises = record?.promises ?? [];
  const promised = promiseFigures(promises);
  const ledger: LedgerEntry[] = record
    ? buildLedger({
        work: work.data,
        decisions: decisions.data.decisions,
        events: record,
        labels,
      })
    : [];
  const notes = record
    ? watchNotes({ work: work.data, events: record, labels })
    : [];
  const visible = ledger.filter((e) => filter === "all" || e.kind === filter);
  const treasury = holdings.data?.treasury;
  const many = money.length > 1;
  const tag = (figures: CurrencyFigures) =>
    many ? ` (${figures.symbol})` : "";

  const link = recordUrl(
    launch.record.id,
    launch.record.author,
    window.location.origin,
  );

  return (
    <div className="flex flex-col gap-4" data-testid="record-tab">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-bold">Track record</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              What this DAO has done with its money, and how much of its team's
              tokens have unlocked. It is read straight from the network, not
              typed in, so anyone can check it and it cannot be edited
              afterwards.
            </p>
          </div>
          <Button
            data-testid="record-copy-link"
            onClick={() => {
              navigator.clipboard
                .writeText(link)
                .then(() => toast.success("Link copied"))
                .catch(() =>
                  toast.error("Couldn't copy the link", { description: link }),
                );
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Copy link
          </Button>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="In the treasury"
          note={
            !launch.record.currency
              ? "This project did not raise money"
              : treasury === null || treasury === undefined
                ? "Could not be read"
                : undefined
          }
          testId="record-figure-treasury"
          value={
            treasury === null || treasury === undefined || !sale
              ? "—"
              : `${formatUnits(treasury, sale.decimals)} ${sale.kind === "custom" ? "USDC" : sale.symbol}`.trim()
          }
        />
        {money.length === 0 ? (
          <Figure
            label="Money set aside for work"
            note="The DAO has not set any aside yet"
            testId="record-figure-approved"
            value="—"
          />
        ) : (
          money.flatMap((f) => [
            <Figure
              key={`${f.currency}-approved`}
              label={`Set aside for work${tag(f)}`}
              testId="record-figure-approved"
              value={amount(f, f.approved)}
            />,
            <Figure
              key={`${f.currency}-paid`}
              label={`Paid to contributors${tag(f)}`}
              testId="record-figure-paid"
              value={amount(f, f.paid)}
            />,
            <Figure
              key={`${f.currency}-waiting`}
              label={`Waiting to be paid${tag(f)}`}
              note="Work that is filed or approved"
              testId="record-figure-waiting"
              value={amount(f, f.waiting)}
            />,
          ])
        )}
        <Figure
          label="Pieces of work"
          note={`${workCounts.paid} paid · ${workCounts.inReview} in review · ${workCounts.notPaid} not paid`}
          testId="record-figure-work"
          value={String(workCounts.filed)}
        />
        <Figure
          label="Shares awarded for work"
          note={`${shares(workCounts.sharesSetAside)} set aside for projects`}
          testId="record-figure-awarded"
          value={shares(workCounts.sharesAwarded)}
        />
        <Figure
          label="Decisions"
          note={`${decisionCounts.open} open · ${decisionCounts.ran} carried out · ${decisionCounts.didNotPass} did not pass`}
          testId="record-figure-decisions"
          value={String(decisions.data.total)}
        />
      </div>

      <Card className="p-4" data-testid="record-promises">
        <h3 className="text-sm font-semibold">The team&apos;s tokens</h3>
        {promises.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {events.isLoading
              ? "Reading…"
              : "No one's Shares are held back behind milestones here."}
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              The team can vote with all of their Shares from the start, but the
              part tied to a milestone cannot be sold or taken out until the
              reviewers approve that milestone.{" "}
              <span data-testid="record-promise-summary">
                {promised.reached} of {promised.milestones} milestones reached.{" "}
                {shares(promised.held)} Shares still held back,{" "}
                {shares(promised.freed)} freed
                {promised.givenUp > 0n
                  ? `, ${shares(promised.givenUp)} given up by the DAO`
                  : ""}
                .
              </span>
            </p>
            <ul className="mt-3 flex flex-col gap-3">
              {promises.map((person) => (
                <li
                  className="rounded-xl border border-border/60 p-3"
                  data-testid="record-person"
                  key={person.holder}
                >
                  <p className="text-sm font-medium">
                    {labels.person(person.holder)}
                  </p>
                  <ul className="mt-1 divide-y divide-border/60">
                    {person.tranches.map((t) => (
                      <li
                        className="flex flex-wrap items-baseline justify-between gap-2 py-1.5 text-sm"
                        data-testid="record-tranche"
                        key={t.index}
                      >
                        <span>
                          Milestone {t.index + 1}
                          {milestoneWords.get(t.checkHash.toLowerCase())
                            ? `: ${milestoneWords.get(t.checkHash.toLowerCase())}`
                            : ""}{" "}
                          · {shares(t.amount)} Shares
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t.unlocked
                            ? t.reachedAt
                              ? `Reached on ${day(t.reachedAt)}`
                              : "Reached"
                            : t.forfeited
                              ? "Given up by the DAO"
                              : "Not reached yet"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {notes.length > 0 ? (
        <Card className="p-4" data-testid="record-notes">
          <h3 className="text-sm font-semibold">Worth knowing</h3>
          <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <HoldersCard
        contracts={contractNames(work.data)}
        dao={dao}
        failed={holders.isError}
        labelOf={labels.person}
        loading={holders.isLoading}
        read={holders.data}
      />

      <Card className="p-4" data-testid="record-ledger">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">What happened</h3>
          <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
            <legend className="sr-only">Show</legend>
            {FILTERS.map((f) => (
              <button
                aria-pressed={filter === f.id}
                className={`rounded-full border px-3 py-1 text-xs ${
                  filter === f.id
                    ? "border-foreground bg-foreground text-background"
                    : "border-border/60 text-muted-foreground"
                }`}
                key={f.id}
                onClick={() => {
                  setFilter(f.id);
                  setShown(PAGE);
                }}
                type="button"
              >
                {f.label}
              </button>
            ))}
          </fieldset>
        </div>
        {events.isLoading ? (
          <p className="mt-2 text-sm text-muted-foreground">Reading…</p>
        ) : events.isError ? (
          <p className="mt-2 text-sm">
            Couldn't read the history from the network. The figures above are
            still right; try again in a moment.
          </p>
        ) : visible.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing here yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border/60">
            {visible.slice(0, shown).map((entry) => (
              <li
                className="flex items-start justify-between gap-3 py-2"
                data-testid="record-entry"
                key={entry.key}
              >
                <div className="min-w-0">
                  <p className="text-sm">{entry.text}</p>
                  {entry.detail ? (
                    <p className="text-xs text-muted-foreground">
                      {entry.detail}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {entry.when > 0 ? day(entry.when) : "No date on record"}
                  </p>
                </div>
                {entry.tab ? (
                  <Button
                    onClick={() => onOpen(entry.tab as "decisions" | "work")}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Open
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {visible.length > shown ? (
          <Button
            className="mt-2"
            onClick={() => setShown((n) => n + PAGE)}
            size="sm"
            type="button"
            variant="outline"
          >
            Show more
          </Button>
        ) : null}
      </Card>

      <details className="rounded-xl border border-border/60 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium select-none">
          Technical details: where to check this
        </summary>
        <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
          <li>
            DAO: <code>{dao}</code>
          </li>
          {context.data ? (
            <li>
              Shares: <code>{context.data.shares}</code>
            </li>
          ) : null}
          {record?.lock ? (
            <li>
              Milestone lock: <code>{record.lock}</code>
            </li>
          ) : null}
          {work.data.mandates.map((m) => (
            <li key={m.address}>
              Work budget: <code>{m.address}</code>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
