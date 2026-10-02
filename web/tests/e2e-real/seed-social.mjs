/**
 * Seed a small social graph for the social real-relay suite:
 *
 *   node --experimental-strip-types tests/e2e-real/seed-social.mjs [db-url] [relay-ws-url]
 *
 * Needs the relay running and `seed.mjs` already run (it seeds the community
 * host). Adds alice, bob and carol as relay members, then publishes standard
 * Nostr events as them: profiles, follows, posts with hashtags / a mention /
 * an image, replies, likes, a repost and an end-to-end encrypted DM to the dev
 * identity. Writes `.social-fixture.json` with the ids the tests look for.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { finalizeEvent } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { npubEncode } from "nostr-tools/nip19";

import { createDirectMessageWraps } from "../../src/features/social/lib/nip17.ts";
import {
  PEOPLE,
  keyFromHex,
  post,
  pubkeyOf,
  publishSigned,
} from "./social-helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dbUrl =
  process.argv[2] ??
  process.env.DATABASE_URL ??
  "postgres://buzz:buzz_dev@localhost:5432/buzz_web_verify";
const relay =
  process.argv[3] ?? process.env.BUZZ_REAL_RELAY_URL ?? "ws://localhost:3199";

const pk = Object.fromEntries(Object.keys(PEOPLE).map((n) => [n, pubkeyOf(n)]));

for (const name of ["alice", "bob", "carol"]) {
  execFileSync(
    "psql",
    [
      dbUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `INSERT INTO relay_members (community_id, pubkey, role, added_by)
         SELECT id, '${pk[name]}', 'member', 'seed' FROM communities
         WHERE lower(host) = 'localhost:3199' ON CONFLICT DO NOTHING;`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

const now = Math.floor(Date.now() / 1000);
// The relay refuses events more than 15 minutes from its clock, so the story
// is told in compressed time: an "hour" here is twelve seconds.
const at = (secondsAgo) => ({ created_at: now - Math.floor(secondsAgo / 5) });

// Profiles.
const profile = (name, display, about) =>
  post(
    name,
    {
      kind: 0,
      tags: [],
      content: JSON.stringify({ name, display_name: display, about }),
      ...at(3600),
    },
    relay,
  );
await profile(
  "alice",
  "Alice Archer",
  "Building in public. Coffee, compilers and #creaton.",
);
await profile("bob", "Bob Builder", "Ships things. Reads every reply.");
await profile("carol", "Carol Coder", "Open source maintainer.");
await profile("dev", "Dev Tester", "The identity the browser tests run as.");

// Follows: dev follows alice; bob follows alice+carol; carol follows alice+dev.
const follows = (name, who) =>
  post(
    name,
    { kind: 3, tags: who.map((w) => ["p", pk[w]]), content: "", ...at(3000) },
    relay,
  );
await follows("dev", ["alice"]);
await follows("bob", ["alice", "carol"]);
await follows("carol", ["alice", "dev"]);

// Posts.
const aliceFirst = await post(
  "alice",
  {
    kind: 1,
    tags: [["t", "creaton"]],
    content: "Shipping the first Creaton social feed today. #creaton",
    ...at(2400),
  },
  relay,
);
const aliceImage = await post(
  "alice",
  {
    kind: 1,
    tags: [],
    content: "A picture of the whiteboard https://example.com/whiteboard.png",
    ...at(2200),
  },
  relay,
);
const aliceLaunch = await post(
  "alice",
  {
    kind: 1,
    tags: [["t", "launch"]],
    content: "Hot take: ship small, ship often. #launch #creaton",
    ...at(2000),
  },
  relay,
);
const bobMention = await post(
  "bob",
  {
    kind: 1,
    tags: [
      ["p", pk.dev],
      ["t", "creaton"],
    ],
    content: `Hey nostr:${npubEncode(pk.dev)} want to review this? #creaton`,
    ...at(1800),
  },
  relay,
);
const carolPost = await post(
  "carol",
  {
    kind: 1,
    tags: [],
    content: "Maintainer life: 40 open issues and a good attitude.",
    ...at(1500),
  },
  relay,
);
// A post by the dev identity, so the dev notifications have something to react to.
const devPost = await post(
  "dev",
  {
    kind: 1,
    tags: [["t", "creaton"]],
    content: "Testing the Creaton feed from a real relay. #creaton",
    ...at(1200),
  },
  relay,
);

// Replies (NIP-10 marked tags).
const reply = (name, root, parent, content, secondsAgo) =>
  post(
    name,
    {
      kind: 1,
      tags: [
        ["e", root.id, "", "root"],
        ...(parent.id !== root.id ? [["e", parent.id, "", "reply"]] : []),
        ["p", root.pubkey],
        ["p", parent.pubkey],
      ],
      content,
      ...at(secondsAgo),
    },
    relay,
  );
const bobReply = await reply(
  "bob",
  aliceFirst,
  aliceFirst,
  "Congrats Alice, this looks great!",
  1000,
);
await reply("carol", aliceFirst, bobReply, "Agreed with Bob, nice work.", 900);
await reply("alice", devPost, devPost, "Welcome to the feed, Dev!", 800);

// Likes.
const like = (name, target, secondsAgo) =>
  post(
    name,
    {
      kind: 7,
      tags: [
        ["e", target.id],
        ["p", target.pubkey],
        ["k", "1"],
      ],
      content: "+",
      ...at(secondsAgo),
    },
    relay,
  );
await like("bob", aliceFirst, 700);
await like("carol", aliceFirst, 650);
await like("alice", devPost, 600);
await like("bob", devPost, 590);
await like("carol", carolPost, 580);

// Carol reposts Alice's launch post (original embedded, as NIP-18 clients do).
const embedded = finalizeEvent(
  {
    kind: 1,
    tags: [["t", "launch"]],
    content: aliceLaunch.content,
    created_at: aliceLaunch.created_at,
  },
  keyFromHex(PEOPLE.alice),
);
await post(
  "carol",
  {
    kind: 6,
    tags: [
      ["e", aliceLaunch.id],
      ["p", pk.alice],
    ],
    content: JSON.stringify(embedded),
    ...at(500),
  },
  relay,
);
// Bob quote-posts the image post.
await post(
  "bob",
  {
    kind: 1,
    tags: [
      ["q", aliceImage.id, "", pk.alice],
      ["p", pk.alice],
    ],
    content: `Love this whiteboard. nostr:${(await import("nostr-tools/nip19")).neventEncode({ id: aliceImage.id, author: pk.alice })}`,
    ...at(400),
  },
  relay,
);

// An end-to-end encrypted DM from alice to dev (NIP-17 gift wrap).
const aliceSigner = {
  pubkey: pk.alice,
  sign: async (template) =>
    finalizeEvent({ created_at: now, ...template }, keyFromHex(PEOPLE.alice)),
  encrypt: async (peer, text) =>
    nip44.encrypt(
      text,
      nip44.getConversationKey(keyFromHex(PEOPLE.alice), peer),
    ),
  decrypt: async (peer, text) =>
    nip44.decrypt(
      text,
      nip44.getConversationKey(keyFromHex(PEOPLE.alice), peer),
    ),
};
const dm = await createDirectMessageWraps(
  aliceSigner,
  pk.dev,
  "Hi Dev - this message is end-to-end encrypted.",
);
for (const wrap of [dm.toRecipient, dm.toSelf]) {
  const result = await publishSigned(PEOPLE.alice, wrap, relay);
  if (!result.accepted) throw new Error(`gift wrap refused: ${result.reason}`);
}

writeFileSync(
  join(here, ".social-fixture.json"),
  JSON.stringify(
    {
      relay,
      people: pk,
      nsecs: PEOPLE,
      notes: {
        aliceFirst: aliceFirst.id,
        aliceImage: aliceImage.id,
        aliceLaunch: aliceLaunch.id,
        bobMention: bobMention.id,
        carolPost: carolPost.id,
        devPost: devPost.id,
      },
    },
    null,
    2,
  ) + "\n",
);
console.log("seeded the social graph");
