/**
 * Whether a project is already on the network under a key, asked of the Launcher. The Launcher refuses an unknown key
 * with its own error (`UnknownProject`), which here means "not launched"; any other failure (the network did not answer,
 * the answer was not readable) is thrown, because "could not tell" is not "no": a press that sends a second launch is
 * never offered on a guess.
 */
import { readProjectParts } from "@creaton/core/pot/pot-state.ts";
import type { ReadCall } from "@creaton/core/pot/pot-reads.ts";
import { potRefusalOf } from "../money/problems";

export async function isLaunched(
  read: ReadCall,
  launcher: string,
  key: string,
): Promise<boolean> {
  try {
    await readProjectParts(read, launcher, key);
    return true;
  } catch (error) {
    if (potRefusalOf(error)?.name === "UnknownProject") return false;
    // `readProjectParts` says this itself when the Launcher answers with an empty project instead of refusing.
    if (
      error instanceof Error &&
      error.message === "The network does not know this project."
    )
      return false;
    throw error;
  }
}
