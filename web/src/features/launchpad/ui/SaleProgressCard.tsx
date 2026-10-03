/**
 * The founder's next steps once the sale is prepared but not yet open: deploy,
 * open it, tell supporters. It replaces the idea checklist, so the guidance
 * never disappears right when the work gets harder.
 */

import { Card } from "@/shared/ui/card";
import { Button } from "@/shared/ui/button";

import { nextSaleStep, saleSteps } from "../lib/sale-steps";
import type { Launch } from "../models";
import { ProgressStep } from "./ProgressStep";

export function SaleProgressCard({
  launch,
  onOpenManage,
  onPostUpdate,
}: {
  launch: Launch;
  onOpenManage(): void;
  onPostUpdate(): void;
}) {
  const steps = saleSteps(launch.record, launch.updates.length);
  const next = nextSaleStep(steps);
  return (
    <Card className="p-4" data-testid="sale-progress">
      <h2 className="text-sm font-bold">Getting your sale open</h2>
      <p className="text-xs text-muted-foreground">
        {next
          ? `Next: ${next.label.toLowerCase()}.`
          : "Everything is done. Backers can join."}
      </p>
      <ul className="mt-2 divide-y divide-border/60">
        {steps.map((step) => (
          <ProgressStep done={step.done} key={step.key} title={step.label}>
            {!step.done ? (
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <p className="text-xs text-muted-foreground">{step.hint}</p>
                {step.action && next?.key === step.key ? (
                  <Button
                    data-testid={`sale-step-${step.key}`}
                    onClick={
                      step.action === "manage" ? onOpenManage : onPostUpdate
                    }
                    size="sm"
                  >
                    {step.action === "manage"
                      ? "Open Manage"
                      : "Post an update"}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </ProgressStep>
        ))}
      </ul>
    </Card>
  );
}
