import { KIND_PROFILE } from "@creaton/core/kinds.ts";
import { publishAsUser, readLatest } from "./relay";

/**
 * Publish the person's profile with `name` and `about`, keeping every other field their newest profile already has
 * (a picture set in another app is not erased).
 */
export async function saveProfile(
  pubkey: string,
  fields: { name: string; about?: string },
): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    const latest = await readLatest(KIND_PROFILE, pubkey);
    const parsed: unknown = latest ? JSON.parse(latest.content) : null;
    if (parsed && typeof parsed === "object")
      current = parsed as Record<string, unknown>;
  } catch {
    // Nothing readable yet: start from an empty profile.
  }
  const name = fields.name.trim();
  const content: Record<string, unknown> = {
    ...current,
    name,
    display_name: name,
  };
  if (fields.about !== undefined) {
    const about = fields.about.trim();
    if (about) content.about = about;
    else delete content.about;
  }
  await publishAsUser(
    { kind: KIND_PROFILE, tags: [], content: JSON.stringify(content) },
    "Your name could not be saved. Try again.",
  );
}
