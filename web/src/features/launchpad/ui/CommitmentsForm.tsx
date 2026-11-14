/**
 * The commitments a sale needs before it can go live: a longer story, how often
 * backers will hear from the founder, and a monthly budget. Inline in the
 * founder's checklist, so it is asked when it matters, not up front.
 */

import { useState } from "react";

import { Button } from "@/shared/ui/button";

import {
  BUDGET_CHOICES,
  CADENCES,
  commitmentFields,
  commitmentIssue,
} from "../lib/commitments";

export function CommitmentsForm({
  requiredRaised,
  saving,
  error,
  onSave,
}: {
  requiredRaised: string;
  saving: boolean;
  error: string | null;
  onSave(fields: {
    longPitch: string;
    updateCadence: string;
    budget: string;
  }): void;
}) {
  const [longPitch, setLongPitch] = useState("");
  const [cadence, setCadence] = useState<string>(CADENCES[0].value);
  const [budgetShare, setBudgetShare] = useState<number>(10);
  const form = { longPitch, cadence, budgetShare };
  const issue = commitmentIssue(form);
  return (
    <div className="mt-2 flex flex-col gap-3" data-testid="commitments-form">
      <div>
        <label className="text-sm font-medium" htmlFor="commit-story">
          Tell backers more
        </label>
        <textarea
          className="mt-1 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus:border-ring focus:outline-none"
          data-testid="commit-story"
          id="commit-story"
          onChange={(event) => setLongPitch(event.target.value)}
          placeholder="Who is building this, what exists already, and what the money is for."
          rows={4}
          value={longPitch}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-sm font-medium" htmlFor="commit-cadence">
            How often will you update backers?
          </label>
          <select
            className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            data-testid="commit-cadence"
            id="commit-cadence"
            onChange={(event) => setCadence(event.target.value)}
            value={cadence}
          >
            {CADENCES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="commit-budget">
            Monthly budget
          </label>
          <select
            className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            data-testid="commit-budget"
            id="commit-budget"
            onChange={(event) => setBudgetShare(Number(event.target.value))}
            value={budgetShare}
          >
            {BUDGET_CHOICES.map((share) => (
              <option key={share} value={share}>
                {share}% of the raise
              </option>
            ))}
          </select>
        </div>
      </div>
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          data-testid="commit-save"
          disabled={issue !== null || saving}
          onClick={() => onSave(commitmentFields(form, requiredRaised))}
          size="sm"
        >
          {saving ? "Saving…" : "Save commitments"}
        </Button>
        {issue && longPitch.length > 0 ? (
          <span className="text-xs text-muted-foreground">{issue}</span>
        ) : null}
      </div>
    </div>
  );
}
