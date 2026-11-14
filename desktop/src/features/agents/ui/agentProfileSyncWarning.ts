import { toast } from "sonner";

export function showAgentProfileSyncWarning(
  agentName: string,
  profileSyncError: string | null,
) {
  if (!profileSyncError) return;
  toast.warning(
    `${agentName} was saved locally, but the sync to the server failed: ${profileSyncError}. Remote users may still see the previous name or access policy until Creaton retries the sync.`,
  );
}
