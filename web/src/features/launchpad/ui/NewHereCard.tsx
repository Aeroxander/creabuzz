/**
 * "New here?" on a contributor project's Overview (`lib/newcomer.ts`): three steps for someone with no Shares in the
 * project, ticked from what they did. Read the aim and Now, take on one small piece, then read the check note that
 * follows. It goes away once those are done. Nobody else sees it.
 */

import { Check } from "lucide-react";
import { useState } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { newcomerSteps, type NewcomerStep } from "../lib/newcomer";
import type { Launch } from "../models";
import { useCheckNotes } from "../use-check-notes";
import { useTakenOn } from "../use-project-structure";
import { useDaoHolders } from "../use-work";

/** Whether this browser was told the aim and Now were read, for this project: a per-viewer convenience only. */
function readKey(launch: Launch): string {
  return `creaton.new-here-read.${launch.record.author}.${launch.record.id}`;
}
function storedRead(launch: Launch): boolean {
  try {
    return window.localStorage.getItem(readKey(launch)) === "1";
  } catch {
    return false;
  }
}

export function NewHereCard({
  launch,
  dao,
  wallet,
  onOpenWork,
}: {
  launch: Launch;
  dao: string;
  /** The acting account, whose Shares say whether this person is new. */
  wallet: string | null;
  onOpenWork: () => void;
}) {
  const me = existingUserPubkey();
  const holders = useDaoHolders(dao);
  const takenOn = useTakenOn(launch);
  const notes = useCheckNotes(launch);
  const [read, setRead] = useState(() => storedRead(launch));
  const holdsShares = holders.data
    ? wallet !== null &&
      holders.data.holders.some(
        (h) => h.holder === wallet.toLowerCase() && h.balance > 0n,
      )
    : null;
  const { show, done } = newcomerSteps({
    me,
    founder: launch.record.author,
    holdsShares,
    read,
    myTakings: (takenOn.query.data ?? [])
      .filter((t) => t.author === me)
      .map((t) => t.createdAt),
    notes: (notes.query.data ?? []).map((n) => n.createdAt),
  });
  if (!show) return null;

  const markRead = () => {
    setRead(true);
    try {
      window.localStorage.setItem(readKey(launch), "1");
    } catch {
      // Not kept in this browser: the step is ticked for this visit only.
    }
  };
  const scrollTo = (testId: string) =>
    document
      .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      ?.scrollIntoView({ block: "center" });
  const steps: { key: NewcomerStep; text: string; action: React.ReactNode }[] =
    [
      {
        key: "read",
        text: "Read the project's aim and what the team works on now.",
        action: (
          <Button
            data-testid="new-here-read"
            onClick={() => {
              scrollTo("focus");
              markRead();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Show me
          </Button>
        ),
      },
      {
        key: "take",
        text: "Take on one small piece: say what you will deliver, for whom, and by when.",
        action: (
          <Button
            data-testid="new-here-take"
            onClick={onOpenWork}
            size="sm"
            type="button"
            variant="outline"
          >
            Open work
          </Button>
        ),
      },
      {
        key: "check",
        text: "Read the next check note: what the team expected, what happened, and what changes.",
        action: (
          <Button
            data-testid="new-here-check"
            onClick={() => scrollTo("check-note")}
            size="sm"
            type="button"
            variant="outline"
          >
            Where it is
          </Button>
        ),
      },
    ];
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="new-here">
      <h2 className="text-base font-bold">New here?</h2>
      <p className="text-sm text-muted-foreground">
        Three steps to find your way in this project.
      </p>
      <ol className="flex flex-col gap-2">
        {steps.map((step, i) => (
          <li
            className="flex flex-wrap items-center justify-between gap-2 text-sm"
            data-done={done[step.key] ? "yes" : "no"}
            data-testid="new-here-step"
            key={step.key}
          >
            <span className="flex items-start gap-2">
              <span
                aria-hidden
                className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs ${done[step.key] ? "bg-emerald-600 text-white" : "bg-secondary"}`}
              >
                {done[step.key] ? <Check className="size-3" /> : i + 1}
              </span>
              <span>
                {step.text}
                {done[step.key] ? (
                  <span className="sr-only"> Done.</span>
                ) : null}
              </span>
            </span>
            {done[step.key] ? null : step.action}
          </li>
        ))}
      </ol>
    </Card>
  );
}
