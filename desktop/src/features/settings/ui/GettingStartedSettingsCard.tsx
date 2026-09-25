import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { GettingStartedStepsList } from "@/features/home/ui/GettingStartedChecklist";
import { useGettingStartedDismissal } from "@/features/home/useGettingStartedDismissal";
import { Button } from "@/shared/ui/button";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

/**
 * Settings → Getting started. Re-opening surface for the home checklist card:
 * "Show on Home" clears the dismissal and navigates home (Rule 6 — hiding the
 * card must never remove the only recovery affordance).
 */
export function GettingStartedSettingsCard({
  currentPubkey,
}: {
  currentPubkey?: string;
}) {
  const { restore } = useGettingStartedDismissal(currentPubkey);
  const { goHome } = useAppNavigation();

  return (
    <section className="min-w-0" data-testid="settings-getting-started">
      <SettingsSectionHeader
        action={
          <Button
            onClick={() => {
              restore();
              void goHome();
            }}
            size="sm"
            type="button"
            variant="outline"
            data-testid="getting-started-show-on-home"
          >
            Show on Home
          </Button>
        }
        description="Your getting-started checklist. It appears on Home until you hide it — show it again from here any time."
        title="Getting started"
      />
      <GettingStartedStepsList currentPubkey={currentPubkey} />
    </section>
  );
}
