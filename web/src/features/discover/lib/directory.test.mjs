// Discover directory derivation: four record sources → three sections, with
// malformed rows counted rather than dropped (trust-signals.ts:37 convention).
//
// Fixtures are the *real* builders the app publishes with (buildPitchTemplate,
// buildOwnershipGrantTemplate, the launch/receipt event shapes from
// models.test.mjs), so a fixture drift here is a production drift.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOwnershipGrantTemplate } from "../../projects/lib/grant.ts";
import { buildPitchTemplate } from "../../projects/lib/manifest.ts";
import {
  canBackLaunch,
  deriveDirectory,
  directoryNotice,
  launchTargetText,
  visibleSections,
} from "./directory.ts";

const FOUNDER = "f".repeat(64);
const ALICE = "a".repeat(64);
const DAO = `0x${"11".repeat(20)}`;
const SUMMONER = `0x${"22".repeat(20)}`;
const TX = `0x${"b".repeat(64)}`;
const TX2 = `0x${"c".repeat(64)}`;
const CHAIN = "11155111";
const SEPOLIA = "https://sepolia.etherscan.io";

function pitch({ nodeId = "nebula", created_at = 1_000, id = "p1" } = {}) {
  const template = buildPitchTemplate({
    nodeId,
    name: "Nebula",
    summary: "A social app for stargazers.",
    description: "",
    founderRole: "founder",
    roles: [
      { slug: "founder", label: "The founder", pct: 40 },
      { slug: "writer", label: "The writer", pct: 12 },
      { slug: "designer", label: "The designer", pct: 8 },
    ],
  });
  return {
    id,
    kind: 37015,
    pubkey: FOUNDER,
    created_at,
    tags: template.tags,
    content: template.content,
    sig: "sig",
  };
}

function grant({ role = "writer", created_at = 2_000, id = "g1" } = {}) {
  const template = buildOwnershipGrantTemplate({
    nodeId: "nebula",
    role,
    pct: 12,
    grantee: ALICE,
    issuer: FOUNDER,
  });
  return {
    id,
    kind: 37011,
    pubkey: FOUNDER,
    created_at,
    tags: template.tags,
    content: template.content,
    sig: "sig",
  };
}

function launchRecord({
  slug = "nebula",
  created_at = 500,
  stage = "live",
  ...body
} = {}) {
  return {
    id: `record-${slug}-${created_at}`,
    kind: 37001,
    pubkey: FOUNDER,
    created_at,
    tags: [
      ["d", slug],
      ["name", slug === "nebula" ? "Nebula Launch" : slug],
    ],
    content: JSON.stringify({
      pitch: "Raise for the stargazer app.",
      stage,
      requiredRaised: "6000000",
      currency: "USDC",
      ...body,
    }),
    sig: "sig",
  };
}

function summonReceipt({
  slug = "nebula",
  created_at = 1_300,
  project = "nebula",
  dao = DAO,
  chain = CHAIN,
  id = `receipt-${slug}`,
} = {}) {
  const content = {
    table: "summon",
    project,
    summoner: SUMMONER,
    chain,
    holders: [
      { pubkey: FOUNDER, role: "founder", pct: 40, address: DAO },
      { pubkey: ALICE, role: "writer", pct: 12, address: DAO },
    ],
  };
  if (dao) content.dao = dao;
  return {
    id,
    kind: 47005,
    pubkey: FOUNDER,
    created_at,
    tags: [
      ["a", `37001:${FOUNDER}:${slug}`],
      ["kind", "summon"],
      ["tx", TX],
    ],
    content: JSON.stringify(content),
    sig: "sig",
  };
}

function deployment({
  role = "summoner",
  address = SUMMONER,
  project = "orion",
  tx = TX2,
  chain = CHAIN,
  dao = null,
  d,
  id = `deployment-${role}-${project}`,
  created_at = 1_400,
} = {}) {
  const body = { v: 1, block: 42, note: "summoned by the Summoner" };
  if (project) body.project = project;
  if (dao) body.dao = dao;
  return {
    id,
    kind: 37018,
    pubkey: FOUNDER,
    created_at,
    tags: [
      ["d", d ?? `${chain}:${role}`],
      ["chain", chain],
      ["role", role],
      ["address", address],
      ["tx", tx],
    ],
    content: JSON.stringify(body),
    sig: "sig",
  };
}

describe("deriveDirectory — DAOs from summon receipts", () => {
  it("builds a card with the proven dao address, tx, and explorer links", () => {
    const { daos, counts } = deriveDirectory({
      events: [launchRecord(), summonReceipt()],
    });
    assert.equal(daos.length, 1);
    const card = daos[0];
    assert.equal(card.projectId, "nebula");
    assert.equal(card.dao, DAO);
    assert.equal(card.summonTx, TX);
    assert.equal(card.chainId, 11155111);
    assert.equal(card.addressUrl, `${SEPOLIA}/address/${DAO}`);
    assert.equal(card.txUrl, `${SEPOLIA}/tx/${TX}`);
    assert.deepEqual(card.sources, ["kind:47005 summon receipt"]);
    assert.equal(counts.malformed, 0);
  });

  it("takes team size from the equity map when a pitch exists", () => {
    const { daos } = deriveDirectory({
      events: [pitch(), grant(), launchRecord(), summonReceipt()],
    });
    const card = daos[0];
    assert.equal(card.name, "Nebula", "the pitch names the card");
    assert.equal(card.founder, FOUNDER);
    assert.equal(card.hasPitch, true);
    assert.equal(card.teamSize, 2, "founder + the granted writer seat");
    assert.equal(card.teamSource, "equity-map");
    assert.deepEqual(
      card.openRoles.map((role) => role.slug),
      ["designer"],
      "the granted role is no longer open",
    );
  });

  it("falls back to the receipt's minted seats when there is no pitch", () => {
    const { daos } = deriveDirectory({ events: [summonReceipt()] });
    assert.equal(daos[0].teamSize, 2);
    assert.equal(daos[0].teamSource, "summon-receipt");
    assert.equal(daos[0].hasPitch, false);
  });
});

describe("deriveDirectory — DAOs from kind:37018 deployments", () => {
  it("never labels an infrastructure contract as a DAO address", () => {
    const { daos } = deriveDirectory({ events: [deployment()] });
    const card = daos[0];
    assert.equal(card.projectId, "orion");
    assert.equal(card.dao, null, "a summoner contract is not a treasury");
    assert.deepEqual(card.contract, { role: "summoner", address: SUMMONER });
    assert.equal(card.addressUrl, `${SEPOLIA}/address/${SUMMONER}`);
    assert.deepEqual(card.sources, ["kind:37018 summoner deployment"]);
    assert.equal(card.hasPitch, false, "no pitch claimed that does not exist");
  });

  it("merges a deployment onto the receipt's card instead of doubling it", () => {
    const { daos } = deriveDirectory({
      events: [
        pitch(),
        launchRecord(),
        summonReceipt(),
        deployment({ project: "nebula" }),
      ],
    });
    assert.equal(daos.length, 1, "one card per project id");
    const card = daos[0];
    assert.equal(card.dao, DAO, "the receipt's address wins");
    assert.deepEqual(card.contract, {
      role: "summoner",
      address: SUMMONER,
    });
    assert.deepEqual(card.sources, [
      "kind:47005 summon receipt",
      "kind:37018 summoner deployment",
    ]);
  });
});

describe("deriveDirectory — launches", () => {
  it("lists live launches and leaves drafts to the launchpad", () => {
    const { launches } = deriveDirectory({
      events: [
        launchRecord({ slug: "nebula", stage: "live" }),
        launchRecord({ slug: "orion", stage: "draft" }),
      ],
    });
    assert.deepEqual(
      launches.map((launch) => launch.record.id),
      ["nebula"],
    );
  });

  it("drops a tombstoned launch", () => {
    const { launches } = deriveDirectory({
      events: [
        launchRecord({ slug: "nebula", stage: "live" }),
        {
          id: "tombstone",
          kind: 5,
          pubkey: FOUNDER,
          created_at: 900,
          tags: [["a", `37001:${FOUNDER}:nebula`]],
          content: "",
          sig: "sig",
        },
      ],
    });
    assert.equal(launches.length, 0);
  });

  it("only offers a bid while the raise is still open", () => {
    assert.equal(canBackLaunch("live"), true);
    assert.equal(canBackLaunch("funding"), true);
    for (const stage of ["draft", "review", "graduated", "failed"]) {
      assert.equal(canBackLaunch(stage), false, `${stage} is not backable`);
    }
  });

  it("states the target only when the record carries one, in money units", () => {
    const [live] = deriveDirectory({
      events: [launchRecord({ slug: "nebula" })],
    }).launches;
    assert.equal(launchTargetText(live), "6 USDC", "atomic 6000000 = 6 USDC");
    const [bare] = deriveDirectory({
      events: [launchRecord({ slug: "nebula", requiredRaised: "" })],
    }).launches;
    assert.equal(launchTargetText(bare), null, "absent stays absent");
  });
});

describe("deriveDirectory — open projects", () => {
  it("derives the board's own card, open roles included", () => {
    const { projects } = deriveDirectory({
      events: [pitch(), grant()],
    });
    assert.equal(projects.length, 1);
    assert.equal(projects[0].projectId, "nebula");
    assert.equal(projects[0].members, 2);
    assert.deepEqual(
      projects[0].openRoles.map((role) => role.slug),
      ["designer"],
    );
  });
});

describe("deriveDirectory — counted, never dropped", () => {
  it("counts unreadable rows and still lists every good one", () => {
    const { daos, counts } = deriveDirectory({
      events: [
        launchRecord(),
        summonReceipt(),
        // A summon receipt whose payload never reported a dao.
        summonReceipt({ slug: "orion", project: "orion", dao: null, id: "r2" }),
        // An address tag that is not an address, and a pitch with no `d`.
        deployment({ address: "0xnope", project: "orion", id: "bad" }),
        { ...pitch({ nodeId: "ghost", id: "g-ghost" }), tags: [] },
      ],
    });
    assert.deepEqual(
      daos.map((card) => card.projectId),
      ["nebula"],
      "the readable row is listed despite its broken siblings",
    );
    assert.ok(counts.malformed >= 3, JSON.stringify(counts));
    const notice = directoryNotice(counts);
    assert.match(notice, /could not be read — counted, not listed/);
  });

  it("counts a deployment that names no project, without listing it", () => {
    const { daos, counts } = deriveDirectory({
      events: [deployment({ project: null })],
    });
    assert.equal(daos.length, 0);
    assert.equal(counts.unlinked, 1);
    assert.match(directoryNotice(counts), /name no project/);
  });

  it("still lists a summon receipt whose launch record is missing", () => {
    const { daos, counts } = deriveDirectory({ events: [summonReceipt()] });
    assert.equal(daos.length, 1, "the DAO exists regardless of its launch");
    assert.equal(counts.orphanReceipts, 1);
    assert.match(
      directoryNotice(counts),
      /with no launch record on this relay/,
    );
  });

  it("says nothing when every record parsed", () => {
    const { counts } = deriveDirectory({ events: [launchRecord()] });
    assert.deepEqual(counts, { malformed: 0, unlinked: 0, orphanReceipts: 0 });
    assert.equal(directoryNotice(counts), null);
  });
});

describe("visibleSections", () => {
  it("maps every chip to exactly its own section(s)", () => {
    assert.deepEqual(visibleSections("all"), {
      daos: true,
      launches: true,
      projects: true,
    });
    assert.deepEqual(visibleSections("daos"), {
      daos: true,
      launches: false,
      projects: false,
    });
    assert.deepEqual(visibleSections("fundraising"), {
      daos: false,
      launches: true,
      projects: false,
    });
    assert.deepEqual(visibleSections("hiring"), {
      daos: false,
      launches: false,
      projects: true,
    });
  });
});
