/**
 * A project with a second person on its team who linked their wallet, for the browser specs that hand the seat over or make a
 * Pair: the founder's record naming the team, the teammate's answer to the invitation, both wallet links (anvil's own
 * accounts, whose keys are public test keys), and the server's reading of the chain. Each person has a page of their own;
 * `seedTeamServer` seeds one relay for one page.
 */
import { accountOf, linkedWalletRecord } from "../../helpers/linked-wallet";
import type { LiveProject, LiveWorld } from "./live-chain";
import { FOUNDER_KEY, FOUNDER_NOSTR, seedServer } from "./live-browser";
import type { RecordOptions } from "./live-record";
import { DAY, event, now, profile, projectRecord, type Relay } from "./world";

/** The teammate: a second Creaton account, with a name the screens show. */
export const MATE_KEY = "b7".repeat(32);
export const MATE_NOSTR = accountOf(MATE_KEY);
export const MATE_NAME = "Sam Second";
export const FOUNDER_NAME = "Fay Founder";

export async function seedTeamServer(
  relay: Relay,
  world: LiveWorld,
  project: LiveProject,
  mateAccount: string,
  options: RecordOptions = {},
) {
  const server = await seedServer(relay, world, project, options);
  relay.seed(profile(MATE_NOSTR, MATE_NAME));
  // A newer version of the founder's record: the same project, now naming the teammate.
  relay.seed(
    projectRecord(
      FOUNDER_NOSTR,
      project.label,
      "Lantern",
      "Solar lamps for night markets.",
      now() - 49 * DAY,
      [
        ["chain-key", project.key],
        ["team", MATE_NOSTR, "member"],
        ["team-invite", MATE_NOSTR, "inv1"],
        ["p", MATE_NOSTR],
      ],
    ),
  );
  relay.seed(
    event(
      47003,
      MATE_NOSTR,
      { title: "Joined the team", body: "" },
      [
        ["a", project.coordinate],
        ["l", "creaton-team"],
        ["team-answer", "yes"],
        ["team-invite", "inv1"],
      ],
      now() - 40 * DAY,
    ),
  );
  relay.seed(linkedWalletRecord(MATE_KEY, mateAccount));
  relay.seed(linkedWalletRecord(FOUNDER_KEY, world.who.founder));
  return server;
}
