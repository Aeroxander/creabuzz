import { Button } from "@/shared/ui/button";

/** The create dialog's buttons: shortcuts, Back/Continue, and the one Publish. */
export function WizardFooter({
  isEdit,
  quick,
  canQuick,
  isFirstStep,
  isLastStep,
  stepBlocked,
  publishEnabled,
  isCreating,
  onRecommended,
  onDefaults,
  onQuick,
  onBack,
  onContinue,
  onSubmit,
}: {
  isEdit: boolean;
  /** The quick setup is showing: only Publish applies. */
  quick: boolean;
  /** An idea's sale can return to the quick setup from the full steps. */
  canQuick: boolean;
  isFirstStep: boolean;
  isLastStep: boolean;
  stepBlocked: boolean;
  publishEnabled: boolean;
  isCreating: boolean;
  onRecommended(): void;
  onDefaults(): void;
  onQuick(): void;
  onBack(): void;
  onContinue(): void;
  onSubmit(): void;
}) {
  const showContinue = !isEdit && !quick && !isLastStep;
  return (
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      {quick ? null : (
        <>
          <Button
            data-testid="launch-recommended-terms"
            onClick={onRecommended}
            size="sm"
            type="button"
            variant="outline"
          >
            Recommended terms
          </Button>
          <Button onClick={onDefaults} size="sm" type="button" variant="ghost">
            Quick start defaults
          </Button>
        </>
      )}
      {canQuick && !quick ? (
        <Button
          data-testid="quick-back"
          onClick={onQuick}
          size="sm"
          type="button"
          variant="ghost"
        >
          Quick setup
        </Button>
      ) : null}
      {!isEdit && !quick && !isFirstStep ? (
        <Button onClick={onBack} size="sm" type="button" variant="ghost">
          Back
        </Button>
      ) : null}
      {showContinue ? (
        <Button
          data-testid="wizard-continue"
          disabled={stepBlocked}
          onClick={onContinue}
          type="button"
        >
          Continue
        </Button>
      ) : (
        <Button
          disabled={!publishEnabled || isCreating}
          onClick={onSubmit}
          type="button"
        >
          {isCreating
            ? "Publishing…"
            : isEdit
              ? "Save changes"
              : "Publish launch"}
        </Button>
      )}
    </div>
  );
}
