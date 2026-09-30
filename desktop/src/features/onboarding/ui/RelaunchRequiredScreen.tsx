import { RecoveryScreen } from "./RecoveryScreen";
import { APP_NAME } from "@/shared/constants/brand";

export function RelaunchRequiredScreen() {
  return (
    <RecoveryScreen
      testId="relaunch-required"
      title={`Restart ${APP_NAME} to finish recovery`}
      body="Your identity was updated. Buzz needs to restart so syncing and agents run under it."
    />
  );
}
