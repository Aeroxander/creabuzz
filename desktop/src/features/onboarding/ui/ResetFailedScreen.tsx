import { RecoveryScreen } from "./RecoveryScreen";

export function ResetFailedScreen() {
  return (
    <RecoveryScreen
      testId="reset-failed"
      title="Sign out could not complete"
      body="Creaton couldn't fully clear your local data. Try relaunching. The reset will resume automatically. If this persists, contact support."
    />
  );
}
