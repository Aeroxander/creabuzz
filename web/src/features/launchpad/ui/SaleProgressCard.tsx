/**
 * The founder's next steps once the sale is prepared but not yet open: make the
 * commitments backers weigh, deploy, go live, tell supporters. It replaces the
 * idea checklist, so the guidance never disappears right when the work gets
 * harder.
 */

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { recordToInput } from "../lib/record-input";
import { nextSaleStep, type SaleStep, saleSteps } from "../lib/sale-steps";
import type { Launch } from "../models";
import { useCreateLaunch, type CreateLaunchInput } from "../use-launches";
import { CommitmentsForm } from "./CommitmentsForm";
import { ProgressStep } from "./ProgressStep";

function StepAction({
  step,
  launch,
  saving,
  error,
  onSave,
  onOpenManage,
  onPostUpdate,
}: {
  step: SaleStep;
  launch: Launch;
  saving: boolean;
  error: string | null;
  onSave(overrides: Partial<CreateLaunchInput>, done: string): void;
  onOpenManage(): void;
  onPostUpdate(): void;
}) {
  const [editing, setEditing] = useState(false);
  switch (step.action) {
    case "commitments":
      return editing ? (
        <CommitmentsForm
          error={error}
          onSave={(fields) => onSave(fields, "Commitments saved.")}
          requiredRaised={launch.record.requiredRaised ?? ""}
          saving={saving}
        />
      ) : (
        <Button
          data-testid="sale-step-commitments"
          onClick={() => setEditing(true)}
          size="sm"
        >
          Add commitments
        </Button>
      );
    case "manage":
      return (
        <Button
          data-testid={`sale-step-${step.key}`}
          onClick={onOpenManage}
          size="sm"
        >
          Open Manage
        </Button>
      );
    case "live":
      return (
        <Button
          data-testid="sale-step-open"
          disabled={saving}
          onClick={() => onSave({ stage: "live" }, "The sale is live.")}
          size="sm"
        >
          {saving ? "Opening…" : "Go live"}
        </Button>
      );
    case "update":
      return (
        <Button
          data-testid="sale-step-announce"
          onClick={onPostUpdate}
          size="sm"
        >
          Post an update
        </Button>
      );
    default:
      return null;
  }
}

export function SaleProgressCard({
  launch,
  onOpenManage,
  onPostUpdate,
}: {
  launch: Launch;
  onOpenManage(): void;
  onPostUpdate(): void;
}) {
  const save = useCreateLaunch();
  const [error, setError] = useState<string | null>(null);
  const steps = saleSteps(launch.record, launch.updates.length);
  const next = nextSaleStep(steps);

  const onSave = async (
    overrides: Partial<CreateLaunchInput>,
    done: string,
  ) => {
    setError(null);
    try {
      await save.mutateAsync(recordToInput(launch.record, overrides));
      toast.success(done);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save. Try again.",
      );
    }
  };

  // Everything done: the walk-through has nothing left to say.
  if (!next) return null;
  return (
    <Card className="p-4" data-testid="sale-progress">
      <h2 className="text-sm font-bold">Getting your sale open</h2>
      <p className="text-xs text-muted-foreground">
        Next: {next.label.toLowerCase()}.
      </p>
      <ul className="mt-2 divide-y divide-border/60">
        {steps.map((step) => (
          <ProgressStep done={step.done} key={step.key} title={step.label}>
            {!step.done ? (
              <div className="mt-1">
                <p className="text-xs text-muted-foreground">{step.hint}</p>
                {step.action && next?.key === step.key ? (
                  <div className="mt-1.5">
                    <StepAction
                      error={error}
                      launch={launch}
                      onOpenManage={onOpenManage}
                      onPostUpdate={onPostUpdate}
                      onSave={(overrides, done) => void onSave(overrides, done)}
                      saving={save.isPending}
                      step={step}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </ProgressStep>
        ))}
      </ul>
    </Card>
  );
}
