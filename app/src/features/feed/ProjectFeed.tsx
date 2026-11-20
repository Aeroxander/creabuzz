import type { ProjectNumbers } from "../money/numbers";
import type { Project } from "../project/project-record";

/** The live feed ("Lately") under a project's top block. A stub made by the page's package; the feed package (A2) owns and overwrites this file. */
export function ProjectFeed(_props: {
  numbers: ProjectNumbers | null;
  project: Project;
}) {
  return null;
}
