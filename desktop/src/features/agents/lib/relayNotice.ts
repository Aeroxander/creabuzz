/**
 * Plain-language guidance for a relay that answered an *error*.
 *
 * The skills read/publish path surfaces relay errors verbatim (a kind:30180
 * publish against a relay older than this build answers
 * `restricted: unknown event kind`), but a verbatim refusal alone sends the
 * reader to re-try something that will never succeed. This is the sentence
 * that says whose fix it is. Mirrors `web/src/shared/lib/relay-failure.ts` —
 * the two apps keep their own copy because they ship separately.
 */

/** The skill definition kind this surface reads and publishes. */
export const SKILL_RECORD_KIND = 30180;

/**
 * Guidance for an answered relay refusal, or null when there is nothing
 * beyond the verbatim message (the caller always renders that itself).
 */
export function olderRelayGuidance(
  message: string | null | undefined,
  kind: number = SKILL_RECORD_KIND,
): string | null {
  if (!message || !/unknown event kind/i.test(message)) return null;
  const named = message.match(/\bkind[:\s]+(\d{3,6})\b/i)?.[1] ?? String(kind);
  return `This relay is running an older build that doesn't know these records (kind ${named}) — restart it from the current build, or point the app at a newer relay.`;
}
