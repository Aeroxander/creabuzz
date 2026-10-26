import { Chip, type ChipTone } from "@/shared/ui/chip";
import type { decisionStage } from "../lib/decision-stage";

const TONES: Record<ReturnType<typeof decisionStage>["tone"], ChipTone> = {
  open: "info",
  good: "success",
  wait: "warning",
  bad: "danger",
  done: "neutral",
};

/** Where a vote stands, as a coloured chip: open, approved, waiting, rejected or done. */
export function StageChip({
  stage,
}: {
  stage: Pick<ReturnType<typeof decisionStage>, "label" | "tone">;
}) {
  return (
    <Chip className="shrink-0" tone={TONES[stage.tone]}>
      {stage.label}
    </Chip>
  );
}
