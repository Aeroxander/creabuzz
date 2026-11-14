/**
 * Fill a dev relay with a believable marketplace so the app can be judged on
 * more than empty states:
 *
 *   node --experimental-strip-types tests/e2e-real/seed-demo.mjs [relay-ws-url]
 *
 * Needs `seed.mjs` and `seed-social.mjs` run first (people and membership).
 * Publishes launch records (kind 37001) and project pitches (kind 37015) as the
 * seeded people. Safe to re-run: records are addressable, so they replace.
 */
import { post, PEOPLE, pubkeyOf } from "./social-helpers.mjs";

const relay =
  process.argv[2] ?? process.env.BUZZ_REAL_RELAY_URL ?? "ws://localhost:3199";
const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

const LAUNCHES = [
  {
    by: "alice",
    id: "nebula-dao",
    name: "Nebula DAO",
    category: "Software",
    stage: "funding",
    goal: "250000000000",
    pitch:
      "A social app for stargazers: telescopes, meet timelines. Backers share in the network's usage fees.",
  },
  {
    by: "bob",
    id: "aurora-labs",
    name: "Aurora Labs",
    category: "AI agents",
    stage: "funding",
    goal: "400000000000",
    pitch:
      "A fleet of research agents that write the weekly brief your team never has time for.",
  },
  {
    by: "carol",
    id: "tidal-records",
    name: "Tidal Records",
    category: "Media",
    stage: "live",
    goal: "120000000000",
    pitch:
      "An artist-owned label. Fans back the album, the artist keeps the masters, royalties flow to holders.",
  },
  {
    by: "alice",
    id: "ember-games",
    name: "Ember Games",
    category: "Games",
    stage: "review",
    goal: "600000000000",
    pitch:
      "A co-op roguelike where the community votes on each season's content.",
  },
  {
    by: "dev",
    id: "quartz-hardware",
    name: "Quartz Hardware",
    category: "Hardware",
    stage: "graduated",
    goal: "90000000000",
    pitch:
      "Open-source e-ink dashboards for small teams. First batch is shipping.",
  },
  {
    by: "bob",
    id: "orbit-commons",
    name: "Orbit Commons",
    category: "Community",
    stage: "funding",
    goal: "75000000000",
    pitch:
      "A neighbourhood fund that pays for the small things nobody else will.",
  },
];

for (const l of LAUNCHES) {
  await post(
    l.by,
    {
      kind: 37001,
      tags: [
        ["d", l.id],
        ["name", l.name],
        ["t", "dao-launchpad"],
        ["t", l.category.toLowerCase()],
        ["admission", "curated"],
        ["chain", "11155111"],
      ],
      content: JSON.stringify({
        pitch: l.pitch,
        stage: l.stage,
        currency: USDC_SEPOLIA,
        floorPrice: "792281625140000",
        tickSpacing: "79228162514",
        requiredRaised: l.goal,
        budget: "5000000000",
        tokenPlan: {
          mode: "mint",
          name: `${l.name} Token`,
          symbol: l.id.slice(0, 3).toUpperCase(),
          supply: "1000000000",
        },
        allocation: {
          sale: 20,
          team: 20,
          treasury: 30,
          liquidity: 15,
          milestones: 10,
          community: 5,
        },
      }),
    },
    relay,
  );
  console.log("launch", l.id);
}

// A run of bids on Nebula, spread over the last quarter hour (the relay refuses
// timestamps further out), so the price chart has candles to draw.
{
  const now = Math.floor(Date.now() / 1000);
  const nebula = `37001:${pubkeyOf("alice")}:nebula-dao`;
  const bidders = ["bob", "carol", "dev", "bob", "carol"];
  let price = 792281625140000n;
  for (let i = 0; i < 28; i++) {
    const wiggle = BigInt(((i * 37) % 11) - 4);
    price = (price * (1000n + wiggle * 6n + 3n)) / 1000n;
    await post(
      bidders[i % bidders.length],
      {
        kind: 47002,
        created_at: now - (28 - i) * 30,
        tags: [
          ["a", nebula],
          ["m", "bucket-1"],
        ],
        content: JSON.stringify({
          budget: String(50_000_000n + BigInt(i % 7) * 40_000_000n),
          maxPrice: price.toString(),
        }),
      },
      relay,
    );
  }
  console.log("bids on nebula-dao");
}

const PITCHES = [
  [
    "alice",
    "stargazer",
    "Stargazer",
    "A telescope network and the app around it.",
    [
      ["founder", "Founder", 40],
      ["designer", "Designer", 12],
      ["writer", "Writer", 8],
    ],
  ],
  [
    "bob",
    "fleet-brief",
    "Fleet Brief",
    "Agents that write your team's weekly brief.",
    [
      ["founder", "Founder", 40],
      ["engineer", "Engineer", 20],
    ],
  ],
  [
    "carol",
    "liner-notes",
    "Liner Notes",
    "Long-form writing about records, paid by readers.",
    [
      ["founder", "Founder", 40],
      ["editor", "Editor", 15],
    ],
  ],
];
for (const [by, id, name, summary, roles] of PITCHES) {
  await post(
    by,
    {
      kind: 37015,
      tags: [
        ["d", id],
        ["name", name],
        ...roles.map(([k, label, pct]) => ["role", k, label, String(pct)]),
      ],
      content: JSON.stringify({
        v: 1,
        summary,
        description: summary,
        founderRole: "founder",
      }),
    },
    relay,
  );
  console.log("pitch", id);
}
console.log(
  "seeded the demo marketplace",
  Object.keys(PEOPLE).map(pubkeyOf).length,
);
process.exit(0);
