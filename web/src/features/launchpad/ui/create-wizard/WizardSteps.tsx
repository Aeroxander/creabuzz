/**
 * The four steps of the create-launch wizard.
 *
 * Presentational: every value and every handler comes from
 * {@link WizardController}, which `CreateLaunchDialog` builds from the same
 * form state the Advanced drawer edits. That is why a choice made here and an
 * override made there cannot disagree — they are one state, reached through
 * two doors (`lib/wizard.ts` holds the derivation and validation rules).
 *
 * Plain language throughout: no blocks, no Q96, no base units. The chain-level
 * truth of a choice is shown honestly in one line (`sale-blocks-conversion`)
 * instead of being asked for as input.
 */

import {
  SALE_DURATIONS,
  SALE_KINDS,
  SALE_PLANS,
  type SaleKind,
} from "../../lib/sale-plans";
import {
  MAX_MILESTONES,
  MILESTONE_TEMPLATES,
  MIN_MILESTONES,
  SHORT_VESTING_MONTHS,
  UNLOCK_ENFORCEMENT_GAP,
} from "../../lib/unlock-plans";
import {
  WIZARD_STEPS,
  type DurationKey,
  type PricingMode,
  type WizardState,
  type WizardStep,
} from "../../lib/wizard";
import type { SaleCurrency } from "../../lib/sale-currency";
import { CurrencyChoice } from "./CurrencyChoice";
import type { SupplyAllocation } from "../../lib/allocation";
import { Field, Segmented, Select, Stepper } from "./fields";
import { SupplySplit } from "./SupplySplit";

/** Everything the steps can read or change, assembled by the dialog. */
export interface WizardController {
  wizard: WizardState;
  patch(next: Partial<WizardState>): void;
  /**
   * The edit surface: the same steps, but create-time plan inputs (sale
   * shape, duration, milestone editor) do not write the record and must not
   * render as if they did. Fields that DO map to the record stay live.
   */
  editing: boolean;
  token: {
    name: string;
    onName(value: string): void;
    symbol: string;
    onSymbol(value: string): void;
    totalSupply: string;
    onTotalSupply(value: string): void;
    launchId: string;
    tokenName: string;
  };
  /** Who holds the supply. One state with the dialog's allocation. */
  supply: {
    allocation: SupplyAllocation;
    onChange(key: keyof SupplyAllocation, value: number): void;
    onReset(): void;
    issue: string | null;
  };
  sale: {
    /** What the sale raises in, and the choices offered on this chain. */
    currency: SaleCurrency;
    currencyChoices: readonly SaleCurrency[];
    onCurrency(value: SaleCurrency): void;
    summary: string;
    conversion: string | null;
    onSaleKind(kind: SaleKind): void;
    onPricingMode(mode: PricingMode): void;
    onPrice(value: string): void;
    onRaiseTarget(value: string): void;
  };
  unlocks: {
    issues: readonly string[];
    onLabel(index: number, value: string): void;
    onPercent(index: number, value: string): void;
    onAdd(): void;
    onRemove(index: number): void;
    adoptTemplate(key: string): void;
    customLadderNote: string | null;
  };
  dao: {
    share: number | "custom";
    onShare(value: number): void;
    capNote: string | null;
    equity: readonly { label: string; pct: number }[] | null;
    equityNote: string;
  };
  stepIssues: readonly string[];
}

export function WizardSteps({
  controller,
  variant = "stepper",
}: {
  controller: WizardController;
  /**
   * `stepper` (create): one step at a time behind the Stepper chrome.
   * `all` (edit): every step body stacked on one page — the same components,
   * so a field can never have two owners across the two surfaces.
   */
  variant?: "stepper" | "all";
}) {
  const { wizard, stepIssues } = controller;
  const stepBody = (key: WizardStep) =>
    key === "token" ? (
      <TokenStep controller={controller} />
    ) : key === "sale" ? (
      <SaleStep controller={controller} />
    ) : key === "unlocks" ? (
      <UnlockStep controller={controller} />
    ) : (
      <DaoStep controller={controller} />
    );
  return (
    <div
      className={
        variant === "all" ? "flex flex-col gap-6" : "flex flex-col gap-4"
      }
    >
      {variant === "stepper" ? (
        <Stepper
          current={wizard.step}
          currentTitle={
            WIZARD_STEPS.find((step) => step.key === wizard.step)?.title ?? ""
          }
          steps={WIZARD_STEPS.map((step) => ({
            key: step.key,
            label: step.label,
          }))}
        />
      ) : null}
      {variant === "all"
        ? WIZARD_STEPS.map((meta) => (
            <section className="flex flex-col gap-3" key={meta.key}>
              <div>
                <h3 className="text-sm font-semibold text-black dark:text-white">
                  {meta.title}
                </h3>
                <p className="text-xs text-black/60 dark:text-white/60">
                  {meta.blurb}
                </p>
              </div>
              {stepBody(meta.key)}
            </section>
          ))
        : stepBody(wizard.step)}
      {stepIssues.length > 0 ? (
        <ul
          className="space-y-0.5 text-xs text-red-600 dark:text-red-400"
          data-testid="wizard-step-issues"
        >
          {stepIssues.map((issue) => (
            <li key={issue}>✗ {issue}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TokenStep({ controller }: { controller: WizardController }) {
  const { token } = controller;
  return (
    <div className="flex flex-col gap-3" data-testid="wizard-step-token">
      <Field
        id="launch-name"
        label="Name"
        hint="The project's name. It also names the launch and suggests the symbol."
      >
        <input
          className="h-9 w-full rounded-md border border-black/15 bg-transparent px-3 text-sm text-black dark:border-white/15 dark:text-white"
          id="launch-name"
          onChange={(event) => token.onName(event.target.value)}
          placeholder="Nebula DAO"
          type="text"
          value={token.name}
        />
      </Field>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Field id="launch-symbol" label="Symbol">
          <input
            className="h-9 w-full rounded-md border border-black/15 bg-transparent px-3 text-sm uppercase text-black dark:border-white/15 dark:text-white"
            id="launch-symbol"
            onChange={(event) => token.onSymbol(event.target.value)}
            placeholder="NEB"
            type="text"
            value={token.symbol}
          />
        </Field>
        <Field
          id="launch-supply"
          label="Total supply"
          hint="Whole tokens. The part your allocation marks as sold is what the sale offers."
        >
          <input
            className="h-9 w-full rounded-md border border-black/15 bg-transparent px-3 text-sm tabular-nums text-black dark:border-white/15 dark:text-white"
            id="launch-supply"
            inputMode="numeric"
            onChange={(event) => token.onTotalSupply(event.target.value)}
            placeholder="1000000000"
            type="text"
            value={token.totalSupply}
          />
        </Field>
      </div>
      <dl className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/10">
        <div className="flex justify-between gap-2">
          <dt className="text-black/60 dark:text-white/60">Token name</dt>
          <dd data-testid="token-name-preview">{token.tokenName || "—"}</dd>
        </div>
        <div className="mt-1 flex justify-between gap-2">
          <dt className="text-black/60 dark:text-white/60">Launch address</dt>
          <dd className="font-mono text-xs" data-testid="launch-id-preview">
            {token.launchId || "—"}
          </dd>
        </div>
      </dl>
      <SupplySplit
        allocation={controller.supply.allocation}
        issue={controller.supply.issue}
        onChange={controller.supply.onChange}
        onReset={controller.supply.onReset}
        totalSupply={token.totalSupply}
      />
      <p className="text-xs text-black/60 dark:text-white/60">
        Everything else — emission, treasury, fees — has a sensible default.
        Change it in Advanced.
      </p>
    </div>
  );
}

function SaleStep({ controller }: { controller: WizardController }) {
  const { wizard, patch, sale, editing } = controller;
  return (
    <div className="flex flex-col gap-3" data-testid="wizard-step-sale">
      <CurrencyChoice
        choices={sale.currencyChoices}
        onChange={sale.onCurrency}
        selected={sale.currency}
      />
      {sale.currency.kind === "eth" ? (
        <p
          className="text-xs text-black/60 dark:text-white/60"
          data-testid="sale-eth-note"
        >
          Prices and targets below are in ETH. Nothing is converted from
          dollars, so check the price against today&apos;s ETH price.
        </p>
      ) : null}
      {/* Sale shape and duration are create-time plan inputs: the published
          record's window and auction are its own, so they do not render on
          the edit surface (no control that writes nothing). */}
      {editing ? null : (
        <>
          <Select
            hint={SALE_PLANS[wizard.saleKind].blurb}
            id="sale-kind"
            label="How it sells"
            onChange={(event) =>
              patch({ saleKind: event.target.value as SaleKind })
            }
            options={SALE_KINDS.map((kind) => ({
              value: kind,
              label: SALE_PLANS[kind].label,
            }))}
            testId="sale-kind"
            value={wizard.saleKind}
          />
          <Select
            id="sale-duration"
            label="How long"
            onChange={(event) =>
              patch({ durationKey: event.target.value as DurationKey })
            }
            options={SALE_DURATIONS.map((duration) => ({
              value: duration.key,
              label: duration.label,
            }))}
            testId="sale-duration"
            value={wizard.durationKey}
          />
          {wizard.durationKey === "custom" ? (
            <Field
              hint="The sale closes at the end of that day, UTC."
              id="sale-end"
              label="Sale ends on"
            >
              <input
                className="h-9 w-full rounded-md border border-black/15 bg-transparent px-3 text-sm text-black dark:border-white/15 dark:text-white"
                id="sale-end"
                onChange={(event) => patch({ endDate: event.target.value })}
                type="date"
                value={wizard.endDate}
              />
            </Field>
          ) : null}
        </>
      )}
      <Segmented
        label="You set it by"
        onChange={sale.onPricingMode}
        options={[
          { value: "price", label: "Price per token" },
          { value: "raise", label: "Raise target" },
        ]}
        testId="pricing-mode"
        value={wizard.pricingMode}
      />
      {wizard.pricingMode === "price" ? (
        <Field
          hint={
            sale.currency.kind === "eth"
              ? "What one token costs, in ETH. 0.000004 is four millionths of an ETH."
              : "What one token costs. 0.01 means a cent."
          }
          id="sale-price"
          label={`Price per token (${sale.currency.symbol})`}
        >
          <input
            className="h-9 w-full rounded-md border border-black/15 bg-transparent px-3 text-sm tabular-nums text-black dark:border-white/15 dark:text-white"
            id="sale-price"
            inputMode="decimal"
            onChange={(event) => sale.onPrice(event.target.value)}
            placeholder={sale.currency.kind === "eth" ? "0.000004" : "0.01"}
            type="text"
            value={wizard.price}
          />
        </Field>
      ) : (
        <Field
          hint={`What the sale has to reach to graduate, in whole ${sale.currency.symbol}.`}
          id="sale-raise"
          label={`Raise target (${sale.currency.symbol})`}
        >
          <input
            className="h-9 w-full rounded-md border border-black/15 bg-transparent px-3 text-sm tabular-nums text-black dark:border-white/15 dark:text-white"
            id="sale-raise"
            inputMode="decimal"
            onChange={(event) => sale.onRaiseTarget(event.target.value)}
            placeholder={sale.currency.kind === "eth" ? "120" : "300000"}
            type="text"
            value={wizard.raiseTarget}
          />
        </Field>
      )}
      <p className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/10">
        {sale.summary}
      </p>
      <p
        className="text-xs text-black/60 dark:text-white/60"
        data-testid="sale-blocks-conversion"
      >
        {sale.conversion}
      </p>
    </div>
  );
}

function UnlockStep({ controller }: { controller: WizardController }) {
  const { wizard, patch, unlocks, editing } = controller;
  if (editing) {
    // The published unlock plan is carried through a save untouched
    // (`FormState.unlocks`); an editor here would be a control that writes
    // nothing. Say so instead (Review-Proven Rule 6 — never fake affordances).
    return (
      <div className="flex flex-col gap-3" data-testid="wizard-step-unlocks">
        <p
          className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/10"
          data-testid="unlock-edit-note"
        >
          Unlocks are chosen when the launch is created. This launch keeps the
          plan it published.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="wizard-step-unlocks">
      <Select
        hint="Your own allocation, and what it releases against."
        id="unlock-mode"
        label="Your unlocks"
        onChange={(event) =>
          patch({
            unlockMode: event.target.value as WizardState["unlockMode"],
          })
        }
        options={[
          {
            value: "milestones",
            label: "Milestone unlocks (recommended)",
          },
          { value: "time", label: "Short vesting" },
          { value: "none", label: "No vesting" },
        ]}
        testId="unlock-mode"
        value={wizard.unlockMode}
      />
      {wizard.unlockMode === "milestones" ? (
        <MilestoneEditor controller={controller} />
      ) : null}
      {wizard.unlockMode === "time" ? (
        <Select
          hint="The startup default, but faster: months from close until your allocation releases."
          id="unlock-months"
          label="Short vesting"
          onChange={(event) => patch({ months: Number(event.target.value) })}
          options={SHORT_VESTING_MONTHS.map((months) => ({
            value: String(months),
            label: `${months} months`,
          }))}
          testId="unlock-months"
          value={String(wizard.months)}
        />
      ) : null}
      {wizard.unlockMode === "none" ? (
        <p className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/10">
          Nothing locks: everything your allocation holds releases when the sale
          closes.
        </p>
      ) : null}
      <p
        className="rounded-lg border border-amber-300/60 p-3 text-xs text-amber-800 dark:border-amber-500/40 dark:text-amber-200"
        data-testid="unlock-gap"
      >
        {UNLOCK_ENFORCEMENT_GAP}
      </p>
      {unlocks.customLadderNote ? (
        <p className="text-xs text-black/60 dark:text-white/60">
          {unlocks.customLadderNote}
        </p>
      ) : null}
    </div>
  );
}

function MilestoneEditor({ controller }: { controller: WizardController }) {
  const { wizard, unlocks } = controller;
  const total = wizard.milestones.reduce((sum, row) => sum + row.percent, 0);
  return (
    <div className="flex flex-col gap-2" data-testid="milestone-editor">
      <div className="flex flex-wrap gap-1.5">
        {MILESTONE_TEMPLATES.map((template) => (
          <button
            className="rounded-full border border-black/15 px-2.5 py-1 text-xs font-medium dark:border-white/15"
            data-testid={`unlock-template-${template.key}`}
            key={template.key}
            onClick={() => unlocks.adoptTemplate(template.key)}
            type="button"
          >
            {template.label}
          </button>
        ))}
      </div>
      {wizard.milestones.map((row, index) => (
        <div
          className="flex items-end gap-2 rounded-lg border border-black/10 p-2 dark:border-white/10"
          key={row.claim}
        >
          <div className="w-8 shrink-0 pb-2 font-mono text-xs text-black/50 dark:text-white/50">
            {row.claim}
          </div>
          <Field
            id={`milestone-label-${index}`}
            label={index === 0 ? "Milestone" : `Milestone ${index + 1}`}
          >
            <input
              className="h-9 w-full rounded-md border border-black/15 bg-transparent px-2 text-sm text-black dark:border-white/15 dark:text-white"
              id={`milestone-label-${index}`}
              onChange={(event) => unlocks.onLabel(index, event.target.value)}
              placeholder="Testnet live"
              type="text"
              value={row.label}
            />
          </Field>
          <div className="w-20 shrink-0">
            <Field id={`milestone-percent-${index}`} label="%">
              <input
                className="h-9 w-full rounded-md border border-black/15 bg-transparent px-2 text-sm tabular-nums text-black dark:border-white/15 dark:text-white"
                id={`milestone-percent-${index}`}
                inputMode="numeric"
                onChange={(event) =>
                  unlocks.onPercent(index, event.target.value)
                }
                type="text"
                value={String(row.percent)}
              />
            </Field>
          </div>
          {wizard.milestones.length > MIN_MILESTONES ? (
            <button
              aria-label={`Remove milestone ${index + 1}`}
              className="pb-2 text-xs text-black/50 hover:underline dark:text-white/50"
              onClick={() => unlocks.onRemove(index)}
              type="button"
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
      <div className="flex items-center justify-between gap-2">
        <button
          className="text-xs font-medium text-black underline underline-offset-2 dark:text-white"
          data-testid="milestone-add"
          disabled={wizard.milestones.length >= MAX_MILESTONES}
          onClick={() => unlocks.onAdd()}
          type="button"
        >
          Add a milestone
        </button>
        <span
          className={`text-xs ${total === 100 ? "text-black/60 dark:text-white/60" : "text-red-600 dark:text-red-400"}`}
          data-testid="milestone-sum"
        >
          {total === 100
            ? "Adds up to 100% of your milestone allocation."
            : `Tranches add up to ${total}% — they must add up to 100%.`}
        </span>
      </div>
      <p className="text-xs text-black/60 dark:text-white/60">
        Who attests each one: you, the founder, for now. The verifier-set picker
        arrives with the rest of the verifier work.
      </p>
      {unlocks.issues.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-red-600 dark:text-red-400">
          {unlocks.issues.map((issue) => (
            <li key={issue}>✗ {issue}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DaoStep({ controller }: { controller: WizardController }) {
  const { wizard, patch, dao } = controller;
  return (
    <div className="flex flex-col gap-3" data-testid="wizard-step-dao">
      <fieldset className="rounded-lg border border-black/10 p-3 dark:border-white/10">
        <legend className="text-sm font-medium text-black dark:text-white">
          Form a DAO at graduation?
        </legend>
        <div className="mt-1 flex gap-4">
          <label className="flex items-center gap-1.5 text-sm">
            <input
              checked={wizard.formDao}
              name="wizard-dao"
              onChange={() => patch({ formDao: true })}
              type="radio"
            />
            Yes
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              checked={!wizard.formDao}
              name="wizard-dao"
              onChange={() => patch({ formDao: false })}
              type="radio"
            />
            No
          </label>
        </div>
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          The summon itself happens from the Project Board after graduation —
          this records the choice on the launch.
        </p>
      </fieldset>
      <Select
        hint="Recorded on the launch and named in the DAO metadata at summon. Starting with nothing is a choice, not a gap — decide before token launch."
        id="dao-legal-wrapper"
        label="Legal wrapper"
        onChange={(event) => patch({ legalWrapper: event.target.value })}
        options={[
          { value: "none", label: "None for now (default)" },
          { value: "dao-llc", label: "DAO LLC" },
          { value: "own-entity", label: "Our own entity" },
        ]}
        value={wizard.legalWrapper}
      />
      <Select
        hint="What the launch can spend each month, as a share of what the sale must raise."
        id="dao-budget"
        label="Operating budget"
        onChange={(event) => dao.onShare(Number(event.target.value))}
        options={[
          { value: "0", label: "No monthly budget" },
          { value: "5", label: "5% of the raise" },
          { value: "10", label: "10% of the raise" },
          { value: "15", label: "15% of the raise" },
          { value: "20", label: "20% of the raise" },
          { value: "25", label: "25% of the raise" },
          ...(dao.share === "custom"
            ? [
                {
                  value: String(dao.share),
                  label: "Custom (set in Advanced)",
                  disabled: true,
                },
              ]
            : []),
        ]}
        testId="dao-budget"
        value={String(dao.share)}
      />
      {dao.capNote ? (
        <p
          className="rounded-lg border border-amber-300/60 p-3 text-xs text-amber-800 dark:border-amber-500/40 dark:text-amber-200"
          data-testid="budget-cap-note"
        >
          {dao.capNote}
        </p>
      ) : null}
      <div
        className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/10"
        data-testid="dao-equity-map"
      >
        <p className="font-medium">Equity map</p>
        <p className="mt-0.5 text-xs text-black/60 dark:text-white/60">
          {dao.equityNote}
        </p>
        {dao.equity && dao.equity.length > 0 ? (
          <ul className="mt-1">
            {dao.equity.map((row) => (
              <li className="flex justify-between gap-2" key={row.label}>
                <span className="text-black/70 dark:text-white/70">
                  {row.label}
                </span>
                <span className="tabular-nums">{row.pct}%</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
