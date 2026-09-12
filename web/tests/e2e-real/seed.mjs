/**
 * Set up everything the real-relay tests need, in one command:
 *
 *   node tests/e2e-real/seed.mjs [db-url] [relay-ws-url] [channel-name]
 *
 * Assumes the relay is already running against that database (see README.md).
 * Community hosts and relay membership come from `seed.sql`; the channel is
 * created through the relay, because channel discovery metadata (kind:39000) is
 * relay-authored and a SQL-inserted channel stays invisible to every client.
 *
 * A second identity is seeded as a relay *and* channel member so the suite can
 * prove a mention from one person reaches another — the p-gated read path that
 * the notification poll depends on.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createChannel, DEV_NSEC } from "./create-channel.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dbUrl =
  process.argv[2] ??
  process.env.DATABASE_URL ??
  "postgres://buzz:buzz_dev@localhost:5432/buzz_web_verify";
const relay =
  process.argv[3] ?? process.env.BUZZ_REAL_RELAY_URL ?? "ws://localhost:3199";
const channelName = process.argv[4] ?? "general";

/** The repository's documented dev test identity (see seed.sql). */
const OWNER_PUBKEY =
  "e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34";
/** A second identity, so a mention can cross from one person to another. */
export const MENTION_NSEC = "11".repeat(32);

const { getPublicKey } = await import("nostr-tools/pure");
const mentionPubkey = getPublicKey(
  Uint8Array.from(
    MENTION_NSEC.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)),
  ),
);

const psql = (args) =>
  execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

console.log("seeding community hosts and relay membership");
psql(["-f", join(here, "seed.sql")]);
psql([
  "-c",
  `INSERT INTO relay_members (community_id, pubkey, role, added_by)
     SELECT id, '${mentionPubkey}', 'member', 'seed' FROM communities
     WHERE lower(host) = 'localhost:3199'
   ON CONFLICT DO NOTHING;`,
]);

console.log(`creating channel "${channelName}" through the relay`);
const channel = await createChannel(channelName, relay);
if (!channel.ok) {
  console.error(`relay refused the channel: ${channel.reason}`);
  process.exit(1);
}

console.log("adding the second identity to the channel");
psql([
  "-c",
  `INSERT INTO channel_members (community_id, channel_id, pubkey, role)
     SELECT c.community_id, c.id, '${mentionPubkey}', 'member'
     FROM channels c JOIN communities co ON c.community_id = co.id
     WHERE lower(co.host) = 'localhost:3199' AND c.name = '${channelName}'
   ON CONFLICT DO NOTHING;`,
]);

/** The suite reads this instead of re-deriving the fixture. */
const fixture = {
  relay,
  channelName,
  ownerPubkey: OWNER_PUBKEY,
  ownerNsec: DEV_NSEC,
  mentionNsec: MENTION_NSEC,
  mentionPubkey,
};
writeFileSync(
  join(here, ".fixture.json"),
  `${JSON.stringify(fixture, null, 2)}
`,
);

console.log(
  `ready: owner ${OWNER_PUBKEY.slice(0, 8)}…, mention identity ${mentionPubkey.slice(0, 8)}… (nsec ${MENTION_NSEC.slice(0, 8)}…)`,
);
console.log("wrote tests/e2e-real/.fixture.json");
