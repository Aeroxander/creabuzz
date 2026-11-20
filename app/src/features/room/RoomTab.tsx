import type { ProfileMetadata } from "../../lib/profiles";
import type { ProjectNumbers } from "../money/numbers";
import type { Project } from "../project/project-record";

/** The holder room, the page's fifth tab. A stub made by the page's package; the room package (A3) owns and overwrites this file. */
export function RoomTab(_props: {
  project: Project;
  numbers: ProjectNumbers | null;
  profiles: Record<string, ProfileMetadata> | undefined;
  team: readonly string[];
}) {
  return null;
}
