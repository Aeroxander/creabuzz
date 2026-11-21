import {
  coordOf,
  DAY,
  event,
  now,
  profile,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./world";

/**
 * The people and posts the social specs (search, saved posts, hidden people, reports) share: a reader who is signed in, two
 * people who write, a project, posts under two topics, and a post of a holder room that carries a topic too.
 */
export const READER_KEY = "e1".repeat(32);
export const FAY_KEY = "e2".repeat(32);
export const MAX_KEY = "e3".repeat(32);
export const READER = pubkeyOf(READER_KEY);
export const FAY = pubkeyOf(FAY_KEY);
export const MAX = pubkeyOf(MAX_KEY);
const ROOM_KEY = `0x${"ab".repeat(32)}`;

export function seedSocial(relay: Relay) {
  relay.seed(profile(READER, "Rae Reader"));
  relay.seed(profile(FAY, "Fay Founder", "Builds solar lamps."));
  relay.seed(profile(MAX, "Max Mate", "Grows seeds."));
  relay.seed(
    projectRecord(
      FAY,
      "lantern",
      "Lantern",
      "Solar lamps for night markets.",
      now() - 3 * DAY,
    ),
  );
  const fay = event(
    1,
    FAY,
    "First solar lamp is lit #lamps",
    [["t", "lamps"]],
    now() - 5 * 3600,
  );
  const max = event(
    1,
    MAX,
    "Seeds are sprouting #seeds #lamps",
    [
      ["t", "seeds"],
      ["t", "lamps"],
    ],
    now() - 3 * 3600,
  );
  // Said in a holder room: it carries the topic too, and must never show outside the room.
  const room = event(
    1,
    FAY,
    "Backers only lamp news #lamps",
    [
      ["a", coordOf(FAY, "lantern")],
      ["t", `room:${ROOM_KEY}`],
      ["t", "lamps"],
    ],
    now() - 2 * 3600,
  );
  for (const e of [fay, max, room]) relay.seed(e);
  return { fay, max, room };
}
