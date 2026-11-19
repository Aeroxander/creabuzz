/**
 * What a project needs to be put on the network and tied to its page: the name and ticker its Shares get, the id and key it
 * is launched under from the founder's wallet, and the founder's own record again, now naming the launch (the record's
 * `chain-key` tag, `@creaton/core/launchpad/project-chain.ts`). Pure.
 */
import {
  chainKeyOf,
  projectIdOf,
  withChainKey,
} from "@creaton/core/launchpad/project-chain.ts";
import { KIND_LAUNCH_RECORD } from "@creaton/core/kinds.ts";
import type { Project } from "../project/project-record";

/** At most `max` bytes of `text` in UTF-8, never cutting a letter in half. */
function fitBytes(text: string, max: number): string {
  const encoder = new TextEncoder();
  let out = "";
  for (const letter of text) {
    if (encoder.encode(out + letter).length > max) break;
    out += letter;
  }
  return out;
}

/** The Shares' name: the project's name, 1 to 64 bytes (`Launcher.launch`), or "Shares" when it has no usable name. */
export function sharesName(name: string): string {
  const trimmed = fitBytes(name.trim().replace(/\s+/g, " "), 64);
  return trimmed || "Shares";
}

/** The Shares' ticker: the name's letters and digits in capitals, at most 11, or "SHARES". */
export function sharesSymbol(name: string): string {
  const letters = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
  return letters.slice(0, 11) || "SHARES";
}

/** The id and key a project is launched under from `founder`'s wallet. */
export function launchIdentity(
  project: Pick<Project, "coordinate">,
  founder: string,
) {
  const projectId = projectIdOf(project.coordinate);
  return { projectId, key: chainKeyOf(founder, projectId) };
}

/**
 * The founder's record again, now naming its launch: every other tag and the content are kept, and it is signed after
 * the newest version so it replaces it.
 */
export function recordWithLaunch(
  project: Project,
  key: string,
  now: number = Math.floor(Date.now() / 1000),
): { kind: number; tags: string[][]; content: string; created_at: number } {
  return {
    kind: KIND_LAUNCH_RECORD,
    tags: withChainKey(project.event.tags, key),
    content: project.event.content,
    created_at: Math.max(now, project.updatedAt + 1),
  };
}
