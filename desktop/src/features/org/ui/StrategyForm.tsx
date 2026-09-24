import * as React from "react";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

import {
  MAX_PHASES,
  MAX_ROUNDS,
  MAX_ROSTER_SLOTS,
  PARENT_STRATEGY_MAX_CHARS,
  ROLE_PROMPT_MAX_CHARS,
  SLOT_NAME_MAX_CHARS,
  STEP_PROMPT_MAX_CHARS,
  STRATEGY_DESC_MAX_CHARS,
  STRATEGY_FLOWS,
  STRATEGY_ID_MAX_CHARS,
  STRATEGY_NAME_MAX_CHARS,
  TEAMWORK_PROMPT_MAX_CHARS,
  addRole,
  addStep,
  charCount,
  moveStepParticipant,
  patchStepFields,
  patchStrategy,
  removeRole,
  removeStep,
  renameRole,
  setRolePrompt,
  setStepPerAgentPrompt,
  toggleStepParticipant,
  type StrategyFieldErrors,
  type StrategyFormState,
  type StrategyStepRow,
} from "../lib/strategyForm";

export type StrategyFormProps = {
  state: StrategyFormState;
  onChange: (state: StrategyFormState) => void;
  /** Live field-key -> message map from validateStrategyState. */
  errors: StrategyFieldErrors;
  /** Error keys revealed so far (blur / submit attempt). */
  revealed: ReadonlySet<string>;
  onReveal: (key: string) => void;
  disabled?: boolean;
  /** Edit mode: the `d` tag is fixed (publishing replaces the head). */
  idReadOnly?: boolean;
};

function FieldError({
  errors,
  revealed,
  fieldKey,
}: {
  errors: StrategyFieldErrors;
  revealed: ReadonlySet<string>;
  fieldKey: string;
}) {
  const message = errors[fieldKey];
  if (!message || !revealed.has(fieldKey)) return null;
  return (
    <p className="text-2xs text-destructive" role="alert">
      {message}
    </p>
  );
}

function LabelRow({
  htmlFor,
  label,
  value,
  max,
  hint,
}: {
  htmlFor: string;
  label: string;
  value: string;
  max: number;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <label className="text-xs font-medium" htmlFor={htmlFor}>
        {label}
      </label>
      <span className="flex items-center gap-2">
        {hint ? (
          <span className="text-2xs text-muted-foreground">{hint}</span>
        ) : null}
        <span className="text-2xs text-muted-foreground">
          {charCount(value)}/{max} chars
        </span>
      </span>
    </div>
  );
}

// ── Role row ──────────────────────────────────────────────────────────────

function RoleRow({
  row,
  index,
  count,
  errors,
  revealed,
  onReveal,
  disabled,
  onSlot,
  onPrompt,
  onRemove,
  ids,
}: {
  row: { slot: string; prompt: string };
  index: number;
  count: number;
  errors: StrategyFieldErrors;
  revealed: ReadonlySet<string>;
  onReveal: (key: string) => void;
  disabled: boolean;
  onSlot: (slot: string) => void;
  onPrompt: (prompt: string) => void;
  onRemove: () => void;
  ids: string;
}) {
  const slotId = `${ids}-role-${index}-slot`;
  const promptId = `${ids}-role-${index}-prompt`;
  const slotKey = `roles[${index}].slot`;
  const promptKey = `roles[${index}].prompt`;
  return (
    <div
      className="space-y-1.5 rounded-md border border-border bg-muted/30 p-2"
      data-testid="strategy-form-role-row"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <LabelRow
            htmlFor={slotId}
            label={`Slot ${index + 1}`}
            max={SLOT_NAME_MAX_CHARS}
            value={row.slot}
          />
          <Input
            disabled={disabled}
            id={slotId}
            onBlur={() => onReveal(slotKey)}
            onChange={(event) => onSlot(event.target.value)}
            placeholder="e.g. agent-0"
            value={row.slot}
          />
          <FieldError errors={errors} fieldKey={slotKey} revealed={revealed} />
        </div>
        <Button
          aria-label={`Remove role ${row.slot || index + 1}`}
          disabled={disabled || count <= 1}
          onClick={onRemove}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="space-y-1.5">
        <LabelRow
          htmlFor={promptId}
          label="Role prompt"
          max={ROLE_PROMPT_MAX_CHARS}
          value={row.prompt}
        />
        <Textarea
          className="min-h-16 resize-y text-sm"
          disabled={disabled}
          id={promptId}
          onBlur={() => onReveal(promptKey)}
          onChange={(event) => onPrompt(event.target.value)}
          placeholder="This member's persistent role in the team…"
          value={row.prompt}
        />
        <FieldError errors={errors} fieldKey={promptKey} revealed={revealed} />
      </div>
    </div>
  );
}

// ── Phase (step) row ──────────────────────────────────────────────────────

function ParticipantToggles({
  step,
  roleSlots,
  errors,
  revealed,
  disabled,
  onToggle,
  onMove,
  ids,
  stepIndex,
}: {
  step: StrategyStepRow;
  roleSlots: string[];
  errors: StrategyFieldErrors;
  revealed: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (slot: string) => void;
  onMove: (from: number, to: number) => void;
  ids: string;
  stepIndex: number;
}) {
  const participantsKey = `steps[${stepIndex}].participants`;
  return (
    <fieldset className="space-y-1.5 border-0 p-0">
      <legend className="text-xs font-medium">
        Participants — in response order
      </legend>
      <p className="text-2xs text-muted-foreground">
        Checked members respond once per round, speaking in the numbered order.
      </p>
      <div className="space-y-1" data-testid="strategy-form-participants">
        {roleSlots.length === 0 ? (
          <p className="text-2xs text-muted-foreground">
            Define a roster slot first.
          </p>
        ) : null}
        {roleSlots.map((slot) => {
          const order = step.participants.indexOf(slot);
          const selected = order >= 0;
          const checkboxId = `${ids}-p${stepIndex}-${slot}`;
          return (
            <div className="flex items-center gap-2" key={slot}>
              <input
                checked={selected}
                className="h-3.5 w-3.5 shrink-0 accent-primary"
                disabled={disabled}
                id={checkboxId}
                onChange={() => onToggle(slot)}
                type="checkbox"
              />
              <label
                className="min-w-0 flex-1 truncate font-mono text-xs"
                htmlFor={checkboxId}
              >
                {slot}
              </label>
              {selected ? (
                <>
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                    #{order + 1}
                  </span>
                  <Button
                    aria-label={`Move ${slot} earlier in response order`}
                    disabled={disabled || order <= 0}
                    onClick={() => onMove(order, order - 1)}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    aria-label={`Move ${slot} later in response order`}
                    disabled={disabled || order >= step.participants.length - 1}
                    onClick={() => onMove(order, order + 1)}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      <FieldError
        errors={errors}
        fieldKey={participantsKey}
        revealed={revealed}
      />
    </fieldset>
  );
}

function StepRow({
  step,
  index,
  count,
  roleSlots,
  errors,
  revealed,
  onReveal,
  disabled,
  onPatch,
  onToggleParticipant,
  onMoveParticipant,
  onPerAgentPrompt,
  onRemove,
  ids,
}: {
  step: StrategyStepRow;
  index: number;
  count: number;
  roleSlots: string[];
  errors: StrategyFieldErrors;
  revealed: ReadonlySet<string>;
  onReveal: (key: string) => void;
  disabled: boolean;
  onPatch: (patch: Partial<StrategyStepRow>) => void;
  onToggleParticipant: (slot: string) => void;
  onMoveParticipant: (from: number, to: number) => void;
  onPerAgentPrompt: (slot: string, prompt: string) => void;
  onRemove: () => void;
  ids: string;
}) {
  const roundsId = `${ids}-step-${index}-rounds`;
  const flowId = `${ids}-step-${index}-flow`;
  const promptId = `${ids}-step-${index}-prompt`;
  const promptKey = `steps[${index}].prompt`;
  const roundsKey = `steps[${index}].rounds`;
  const flowKey = `steps[${index}].flow`;
  const flowInvalid =
    step.flow !== "local" && step.flow !== "summary" && step.flow !== "";
  return (
    <fieldset
      className="space-y-3 rounded-md border border-border bg-muted/30 p-2"
      data-testid="strategy-form-step-row"
    >
      <legend className="px-1 text-xs font-medium">
        Phase {index + 1} of {count}
      </legend>
      <div className="flex justify-end">
        <Button
          aria-label={`Remove phase ${index + 1}`}
          disabled={disabled || count <= 1}
          onClick={onRemove}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ParticipantToggles
        disabled={disabled}
        errors={errors}
        ids={ids}
        onMove={onMoveParticipant}
        onToggle={onToggleParticipant}
        revealed={revealed}
        roleSlots={roleSlots}
        step={step}
        stepIndex={index}
      />
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium" htmlFor={roundsId}>
            Rounds
          </label>
          <Input
            disabled={disabled}
            id={roundsId}
            max={MAX_ROUNDS}
            min={1}
            onBlur={() => onReveal(roundsKey)}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              const clamped = Number.isFinite(parsed)
                ? Math.min(MAX_ROUNDS, Math.max(1, Math.round(parsed)))
                : 1;
              onPatch({ rounds: clamped });
            }}
            step={1}
            type="number"
            value={Number.isFinite(step.rounds) ? String(step.rounds) : ""}
          />
          <FieldError
            errors={errors}
            fieldKey={roundsKey}
            revealed={revealed}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium" htmlFor={flowId}>
            Flow
          </label>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled}
            id={flowId}
            onBlur={() => onReveal(flowKey)}
            onChange={(event) => onPatch({ flow: event.target.value })}
            value={step.flow}
          >
            <option value="">Select…</option>
            {flowInvalid ? (
              <option value={step.flow}>{step.flow}</option>
            ) : null}
            {STRATEGY_FLOWS.map((flow) => (
              <option key={flow} value={flow}>
                {flow}
              </option>
            ))}
          </select>
          <FieldError errors={errors} fieldKey={flowKey} revealed={revealed} />
        </div>
      </div>
      <div className="space-y-1.5">
        <LabelRow
          htmlFor={promptId}
          label="Phase prompt"
          max={STEP_PROMPT_MAX_CHARS}
          value={step.prompt}
        />
        <Textarea
          className="min-h-16 resize-y text-sm"
          disabled={disabled}
          id={promptId}
          onBlur={() => onReveal(promptKey)}
          onChange={(event) => onPatch({ prompt: event.target.value })}
          placeholder="Shared instruction for this phase…"
          value={step.prompt}
        />
        <FieldError errors={errors} fieldKey={promptKey} revealed={revealed} />
      </div>
      {step.participants.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Per-agent prompts (optional)</p>
          {step.participants.map((slot) => {
            const perKey = `steps[${index}].perAgentPrompts[${slot}]`;
            const perId = `${ids}-step-${index}-per-${slot}`;
            return (
              <div className="space-y-1.5" key={slot}>
                <LabelRow
                  htmlFor={perId}
                  label={`Extra prompt for ${slot}`}
                  max={STEP_PROMPT_MAX_CHARS}
                  value={step.perAgentPrompts[slot] ?? ""}
                />
                <Textarea
                  className="min-h-12 resize-y text-sm"
                  disabled={disabled}
                  id={perId}
                  onBlur={() => onReveal(perKey)}
                  onChange={(event) =>
                    onPerAgentPrompt(slot, event.target.value)
                  }
                  placeholder="Overrides the phase prompt for this member only…"
                  value={step.perAgentPrompts[slot] ?? ""}
                />
                <FieldError
                  errors={errors}
                  fieldKey={perKey}
                  revealed={revealed}
                />
              </div>
            );
          })}
        </div>
      ) : null}
    </fieldset>
  );
}

// ── Form ──────────────────────────────────────────────────────────────────

export function StrategyForm({
  state,
  onChange,
  errors,
  revealed,
  onReveal,
  disabled = false,
  idReadOnly = false,
}: StrategyFormProps) {
  const ids = React.useId();
  const idId = `${ids}-id`;
  const nameId = `${ids}-name`;
  const descriptionId = `${ids}-description`;
  const teamworkId = `${ids}-teamwork`;
  const finalWriterId = `${ids}-final-writer`;
  const parentId = `${ids}-parent`;

  const roleSlots = state.roles.map((row) => row.slot);
  const finalWriterInvalid =
    state.finalWriter !== "" && !roleSlots.includes(state.finalWriter);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <LabelRow
            htmlFor={idId}
            hint={idReadOnly ? "fixed (replaces this head)" : undefined}
            label="Strategy id"
            max={STRATEGY_ID_MAX_CHARS}
            value={state.id}
          />
          <Input
            disabled={disabled || idReadOnly}
            id={idId}
            onBlur={() => onReveal("id")}
            onChange={(event) =>
              onChange(patchStrategy(state, { id: event.target.value }))
            }
            placeholder="e.g. mechanistic-step-audit"
            readOnly={idReadOnly}
            value={state.id}
          />
          <FieldError errors={errors} fieldKey="id" revealed={revealed} />
        </div>
        <div className="space-y-1.5">
          <LabelRow
            htmlFor={parentId}
            hint="optional lineage"
            label="Parent strategy"
            max={PARENT_STRATEGY_MAX_CHARS}
            value={state.parentStrategy}
          />
          <Input
            disabled={disabled}
            id={parentId}
            onBlur={() => onReveal("parentStrategy")}
            onChange={(event) =>
              onChange(
                patchStrategy(state, { parentStrategy: event.target.value }),
              )
            }
            placeholder="e.g. sat-smoke-2 (reflection lineage)"
            value={state.parentStrategy}
          />
          <FieldError
            errors={errors}
            fieldKey="parentStrategy"
            revealed={revealed}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <LabelRow
          htmlFor={nameId}
          label="Name"
          max={STRATEGY_NAME_MAX_CHARS}
          value={state.name}
        />
        <Input
          disabled={disabled}
          id={nameId}
          onBlur={() => onReveal("name")}
          onChange={(event) =>
            onChange(patchStrategy(state, { name: event.target.value }))
          }
          placeholder="e.g. Mechanistic step audit"
          value={state.name}
        />
        <FieldError errors={errors} fieldKey="name" revealed={revealed} />
      </div>

      <div className="space-y-1.5">
        <LabelRow
          htmlFor={descriptionId}
          label="Description"
          max={STRATEGY_DESC_MAX_CHARS}
          value={state.description}
        />
        <Textarea
          className="min-h-12 resize-y text-sm"
          disabled={disabled}
          id={descriptionId}
          onBlur={() => onReveal("description")}
          onChange={(event) =>
            onChange(patchStrategy(state, { description: event.target.value }))
          }
          placeholder="What is this strategy for?"
          value={state.description}
        />
        <FieldError
          errors={errors}
          fieldKey="description"
          revealed={revealed}
        />
      </div>

      <div className="space-y-1.5">
        <LabelRow
          htmlFor={teamworkId}
          label="Teamwork prompt"
          max={TEAMWORK_PROMPT_MAX_CHARS}
          value={state.teamworkPrompt}
        />
        <Textarea
          className="min-h-20 resize-y text-sm"
          disabled={disabled}
          id={teamworkId}
          onBlur={() => onReveal("teamworkPrompt")}
          onChange={(event) =>
            onChange(
              patchStrategy(state, { teamworkPrompt: event.target.value }),
            )
          }
          placeholder="Collaboration norms shared by every member…"
          value={state.teamworkPrompt}
        />
        <FieldError
          errors={errors}
          fieldKey="teamworkPrompt"
          revealed={revealed}
        />
      </div>

      {/* Roles */}
      <section className="space-y-2" data-testid="strategy-form-roles">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold">
            Roster — 1 to {MAX_ROSTER_SLOTS} slots
          </h3>
          <Button
            data-testid="strategy-form-add-role"
            disabled={disabled || state.roles.length >= MAX_ROSTER_SLOTS}
            onClick={() => onChange(addRole(state))}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            Add role
          </Button>
        </div>
        {state.roles.map((row, index) => (
          <RoleRow
            count={state.roles.length}
            disabled={disabled}
            errors={errors}
            ids={ids}
            index={index}
            // biome-ignore lint/suspicious/noArrayIndexKey: positional roster rows (roles[i]); rows hold no component state
            key={index}
            onPrompt={(prompt) => onChange(setRolePrompt(state, index, prompt))}
            onReveal={onReveal}
            onRemove={() => onChange(removeRole(state, index))}
            onSlot={(slot) => onChange(renameRole(state, index, slot))}
            revealed={revealed}
            row={row}
          />
        ))}
        <FieldError errors={errors} fieldKey="roles" revealed={revealed} />
      </section>

      {/* Phases */}
      <section className="space-y-2" data-testid="strategy-form-steps">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold">Phases — 1 to {MAX_PHASES}</h3>
          <Button
            data-testid="strategy-form-add-step"
            disabled={disabled || state.steps.length >= MAX_PHASES}
            onClick={() => onChange(addStep(state))}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            Add phase
          </Button>
        </div>
        {state.steps.map((step, index) => (
          <StepRow
            count={state.steps.length}
            disabled={disabled}
            errors={errors}
            ids={ids}
            index={index}
            // biome-ignore lint/suspicious/noArrayIndexKey: positional phase rows (steps[i]); rows hold no component state
            key={index}
            onMoveParticipant={(from, to) =>
              onChange(moveStepParticipant(state, index, from, to))
            }
            onPatch={(patch) => onChange(patchStepFields(state, index, patch))}
            onPerAgentPrompt={(slot, prompt) =>
              onChange(setStepPerAgentPrompt(state, index, slot, prompt))
            }
            onReveal={onReveal}
            onRemove={() => onChange(removeStep(state, index))}
            onToggleParticipant={(slot) =>
              onChange(toggleStepParticipant(state, index, slot))
            }
            revealed={revealed}
            roleSlots={roleSlots}
            step={step}
          />
        ))}
        <FieldError errors={errors} fieldKey="steps" revealed={revealed} />
      </section>

      {/* Final writer */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium" htmlFor={finalWriterId}>
          Final writer
        </label>
        <select
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="strategy-form-final-writer"
          disabled={disabled}
          id={finalWriterId}
          onBlur={() => onReveal("finalWriter")}
          onChange={(event) =>
            onChange(patchStrategy(state, { finalWriter: event.target.value }))
          }
          value={state.finalWriter}
        >
          <option value="">Select a roster slot…</option>
          {finalWriterInvalid ? (
            <option value={state.finalWriter}>{state.finalWriter}</option>
          ) : null}
          {roleSlots.map((slot) => (
            <option key={slot} value={slot}>
              {slot}
            </option>
          ))}
        </select>
        <p className="text-2xs text-muted-foreground">
          Produces the team's final certificate after the last phase.
        </p>
        <FieldError
          errors={errors}
          fieldKey="finalWriter"
          revealed={revealed}
        />
      </div>
    </div>
  );
}
