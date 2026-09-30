/**
 * Budget authoring: create a spend/usage budget for an agent (or the
 * community default). Every limit carries its honest enforcement badge —
 * limits the server counts read "Enforced by the relay", task approvals and
 * unbound spend read "Advisory".
 */

import { useState, type FormEvent } from "react";

import {
  BUDGET_LIMIT_FIELDS,
  COMMUNITY_DEFAULT_SUBJECT,
  ENFORCEMENT_LABEL,
  budgetSubjectError,
  isLimitFieldValid,
  parseLimitField,
  type BudgetLimitInput,
  type BudgetLimitKey,
  type BudgetWindow,
} from "../lib/budgetForm";
import {
  publishBudget,
  useBudgets,
  describeBudgetLimits,
} from "../use-budgets";

const WINDOW_OPTIONS: readonly BudgetWindow[] = [
  "epoch",
  "day",
  "week",
  "month",
];

const EMPTY_DRAFTS: Record<BudgetLimitKey, string> = {
  runs: "",
  messages: "",
  llmCalls: "",
  llmCostCents: "",
  taskCreate: "",
  proposals: "",
  taskApprove: "",
  spend: "",
};

function draftsToInput(
  drafts: Record<BudgetLimitKey, string>,
): BudgetLimitInput {
  const input: BudgetLimitInput = {};
  for (const field of BUDGET_LIMIT_FIELDS) {
    const value = parseLimitField(drafts[field.key]);
    if (value !== undefined) input[field.key] = value;
  }
  return input;
}

export function BudgetAuthorForm() {
  const { reload } = useBudgets();
  const [dtag, setDtag] = useState(() => `budget-${Date.now().toString(36)}`);
  const [subject, setSubject] = useState("");
  const [windowValue, setWindowValue] = useState<BudgetWindow>("week");
  const [drafts, setDrafts] = useState(EMPTY_DRAFTS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);

  const invalidFields = BUDGET_LIMIT_FIELDS.filter(
    (field) => !isLimitFieldValid(drafts[field.key]),
  ).map((field) => field.key);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setCreated(false);
    const subjectError = budgetSubjectError(subject);
    if (subjectError) {
      setError(subjectError);
      return;
    }
    if (invalidFields.length > 0) {
      setError("Limits must be whole numbers of zero or more.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await publishBudget({
        dtag: dtag.trim() || `budget-${Date.now().toString(36)}`,
        subject: subject.trim() === COMMUNITY_DEFAULT_SUBJECT ? "*" : subject,
        window: windowValue,
        limits: draftsToInput(drafts),
      });
      setDrafts(EMPTY_DRAFTS);
      setCreated(true);
      reload();
    } catch (err) {
      // The form keeps its values so the same action is the retry.
      setError(
        err instanceof Error && err.message
          ? `${err.message}`
          : "Couldn’t create the budget. Check the values, then try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
      data-testid="budget-author-form"
      onSubmit={onSubmit}
    >
      <div>
        <h3 className="text-sm font-semibold text-black dark:text-white">
          Create budget
        </h3>
        <p className="text-2xs text-black/60 dark:text-white/60">
          Cap an agent’s runs, messages, or spend. Each limit says plainly
          whether the server enforces it or it is only advisory.
        </p>
      </div>
      <label className="block">
        <span className="text-2xs font-medium text-black/70 dark:text-white/70">
          Budget ID
        </span>
        <input
          className="mt-0.5 w-full rounded-md border border-black/10 bg-background px-2 py-1.5 text-sm dark:border-white/10"
          onChange={(e) => setDtag(e.target.value)}
          value={dtag}
        />
      </label>
      <label className="block">
        <span className="text-2xs font-medium text-black/70 dark:text-white/70">
          Covers agent (64-hex public key, or * for all agents)
        </span>
        <input
          className="mt-0.5 w-full rounded-md border border-black/10 bg-background px-2 py-1.5 text-sm dark:border-white/10"
          data-testid="budget-subject"
          onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. 953d… or *"
          value={subject}
        />
      </label>
      <label className="block">
        <span className="text-2xs font-medium text-black/70 dark:text-white/70">
          Window
        </span>
        <select
          className="mt-0.5 w-full rounded-md border border-black/10 bg-background px-2 py-1.5 text-sm dark:border-white/10"
          onChange={(e) => setWindowValue(e.target.value as BudgetWindow)}
          value={windowValue}
        >
          {WINDOW_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="space-y-2">
        <legend className="text-2xs font-medium text-black/70 dark:text-white/70">
          Limits
        </legend>
        {BUDGET_LIMIT_FIELDS.map((field) => (
          <label className="block" key={field.key}>
            <span className="flex items-center gap-1.5 text-2xs font-medium text-black/70 dark:text-white/70">
              {field.label}
              <span
                className="rounded-sm bg-black/5 px-1 py-0.5 text-2xs text-black/60 dark:bg-white/10 dark:text-white/60"
                data-enforcement={field.enforcement}
                data-testid={`budget-enforcement-${field.key}`}
              >
                {ENFORCEMENT_LABEL[field.enforcement]}
              </span>
            </span>
            <input
              className="mt-0.5 w-full rounded-md border border-black/10 bg-background px-2 py-1.5 text-sm dark:border-white/10"
              inputMode="numeric"
              onChange={(e) =>
                setDrafts((current) => ({
                  ...current,
                  [field.key]: e.target.value,
                }))
              }
              placeholder={field.placeholder}
              value={drafts[field.key]}
            />
            {field.note ? (
              <span className="mt-0.5 block text-2xs text-black/60 dark:text-white/60">
                {field.note}
              </span>
            ) : null}
          </label>
        ))}
      </fieldset>
      {error ? (
        <p
          className="text-2xs text-red-600 dark:text-red-400"
          data-testid="budget-form-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {created ? (
        <p className="text-2xs text-black/70 dark:text-white/70">
          Budget created.
        </p>
      ) : null}
      <button
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        data-testid="budget-form-submit"
        disabled={busy}
        type="submit"
      >
        {busy ? "Creating…" : error ? "Try again" : "Create budget"}
      </button>
    </form>
  );
}

/** Existing budgets with their enforcement badges. */
export function BudgetList() {
  const { budgets, loading, error, reload } = useBudgets();
  if (loading) {
    return (
      <p className="text-2xs text-black/60 dark:text-white/60">Loading…</p>
    );
  }
  if (error) {
    return (
      <div data-testid="budget-list-error">
        <p className="text-2xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
        <button
          className="mt-1 rounded-md border border-black/10 px-2 py-1 text-2xs dark:border-white/10"
          onClick={reload}
          type="button"
        >
          Retry
        </button>
      </div>
    );
  }
  if (budgets.length === 0) {
    return (
      <p className="text-2xs text-black/60 dark:text-white/60">
        No budgets yet.
      </p>
    );
  }
  return (
    <ul className="space-y-2" data-testid="budget-list">
      {budgets.map((budget) => {
        const rows = describeBudgetLimits({
          limits: budget.limits,
          window: budget.window,
          onchain: budget.onchain,
        });
        return (
          <li
            className="rounded-lg border border-black/10 p-2 dark:border-white/10"
            key={budget.id}
          >
            <p className="text-xs font-medium text-black dark:text-white">
              {budget.subject === COMMUNITY_DEFAULT_SUBJECT
                ? "All agents (community default)"
                : (budget.subject ?? budget.dtag)}
              {" · "}
              {budget.window}
            </p>
            {rows.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {rows.map((row) => (
                  <li
                    className="flex items-center gap-1.5 text-2xs text-black/70 dark:text-white/70"
                    key={row.key}
                  >
                    <span>{row.text}</span>
                    <span
                      className="rounded-sm bg-black/5 px-1 py-0.5 text-2xs text-black/60 dark:bg-white/10 dark:text-white/60"
                      data-enforcement={row.enforcement}
                    >
                      {row.badge}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-2xs text-black/60 dark:text-white/60">
                no limits
              </p>
            )}
            <p className="mt-1 text-2xs text-black/60 dark:text-white/60">
              on exceed: {budget.onExceed}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
