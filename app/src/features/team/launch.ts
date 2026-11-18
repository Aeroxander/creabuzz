/**
 * Putting a project on the chain from its page: where the Launcher is, the name and ticker its Shares get, and the two
 * writes it takes (the launch on the network, then the founder's own record naming it).
 *
 * The link from the record to its launch (the record's `chain-key` tag, `@creaton/core/launchpad/project-chain.ts`) is
 * the lead's proposal from milestone 6 part 2 and still waits for the owner's decision; this file writes exactly that
 * tag and nothing the decision could change elsewhere. Pure, apart from reading the build's settings.
 */
import {
  chainKeyOf,
  projectIdOf,
  withChainKey,
} from "@creaton/core/launchpad/project-chain.ts";
import { KIND_LAUNCH_RECORD } from "@creaton/core/kinds.ts";
import type { Project } from "../project/project-record";

/** The Launcher and its network: the build's own (`VITE_CREATON_LAUNCHER`, `VITE_CREATON_CHAIN_ID`), or null. */
export function builtLauncher(
  env: Record<string, unknown> = import.meta.env,
): { launcher: string; chainId: number } | null {
  const launcher = env.VITE_CREATON_LAUNCHER;
  const chain = Number(env.VITE_CREATON_CHAIN_ID);
  if (typeof launcher !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(launcher))
    return null;
  if (!Number.isSafeInteger(chain) || chain <= 0) return null;
  return { launcher: launcher.toLowerCase(), chainId: chain };
}

/** The Launcher a server-signed record of numbers names (its `launcher` and `chain` tags), or null. */
export function launcherFromRecord(
  tags: readonly (readonly string[])[],
): { launcher: string; chainId: number } | null {
  const launcher = tags.find((t) => t[0] === "launcher")?.[1];
  const chain = Number(tags.find((t) => t[0] === "chain")?.[1]);
  if (!launcher || !/^0x[0-9a-fA-F]{40}$/.test(launcher)) return null;
  if (!Number.isSafeInteger(chain) || chain <= 0) return null;
  return { launcher: launcher.toLowerCase(), chainId: chain };
}

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
