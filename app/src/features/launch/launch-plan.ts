/**
 * The launch call made from what the launch sheet shows: the founder's two numbers (checked against the Launcher's
 * ceilings), the project's name and id, and the settings hash the sheet read. The sheet and the chain loop both call this, so
 * what the loop launches is what a person's press launches. Pure.
 */
import { launchCall, type PotCall } from "@creaton/core/pot/pot-calls.ts";
import type { LaunchOffer } from "@creaton/core/pot/pot-state.ts";
import type { Project } from "../project/project-record";
import { launchIdentity, sharesName, sharesSymbol } from "./launch-ids";
import type { LaunchTerms } from "./launch-terms";

export function launchCallFor(input: {
  launcher: string;
  project: Pick<Project, "coordinate" | "name">;
  /** The wallet that signs: the project is stored under this account and the id. */
  founder: string;
  terms: Extract<LaunchTerms, { ok: true }>;
  offer: Pick<LaunchOffer, "settingsHash">;
}): PotCall {
  const { projectId } = launchIdentity(input.project, input.founder);
  return launchCall({
    launcher: input.launcher,
    projectId,
    name: sharesName(input.project.name),
    symbol: sharesSymbol(input.project.name),
    ratePpm: input.terms.ratePpm,
    teamPool: input.terms.teamPool,
    settingsHash: input.offer.settingsHash,
  });
}
