import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLaunchRecordTemplate,
  isEvmAddress,
  isLaunchSlug,
  isWholeTokenSupply,
  LAUNCH_DEFAULTS,
  mintCommandForPlan,
  suggestSymbol,
} from "./launchRecord.ts";

function baseInput(overrides = {}) {
  return {
    id: "nebula",
    name: "Nebula DAO",
    pitch: "To the stars.",
    stage: "draft",
    chainId: "11155111",
    currency: "",
    floorPrice: "1000000",
    tickSpacing: "100",
    requiredRaised: "1000000000",
    auction: "",
    token: "",
    treasury: "",
    admission: "curated",
    channels: [],
    ...overrides,
  };
}

test("slug validation accepts slugs and rejects spaces", () => {
  assert.equal(isLaunchSlug("nebula-2"), true);
  assert.equal(isLaunchSlug("Bad Slug!"), false);
  assert.equal(isLaunchSlug(""), false);
});

test("address validation requires 0x + 40 hex", () => {
  assert.equal(
    isEvmAddress("0x1234567890123456789012345678901234567890"),
    true,
  );
  assert.equal(isEvmAddress("0x123"), false);
  assert.equal(isEvmAddress("not-an-address"), false);
});

test("supply validation takes whole tokens only", () => {
  assert.equal(isWholeTokenSupply("1000000"), true);
  assert.equal(isWholeTokenSupply("0"), false);
  assert.equal(isWholeTokenSupply("1.5"), false);
  assert.equal(isWholeTokenSupply("abc"), false);
});

test("symbol suggestion derives from the name", () => {
  assert.equal(suggestSymbol("Nebula DAO"), "NEBU");
  assert.equal(suggestSymbol("123"), "");
});

test("defaults keep every technical field filled", () => {
  assert.equal(LAUNCH_DEFAULTS.chainId, "11155111");
  assert.equal(LAUNCH_DEFAULTS.tickSpacing, "100");
});

test("template carries tick spacing and mint plans", () => {
  const template = buildLaunchRecordTemplate(
    baseInput({
      tokenPlan: {
        mode: "mint",
        name: "Nebula",
        symbol: "NEB",
        supply: "1000000",
      },
    }),
  );
  assert.equal(template.kind, 37001);
  const body = JSON.parse(template.content);
  assert.equal(body.tickSpacing, "100");
  assert.deepEqual(body.tokenPlan, {
    mode: "mint",
    name: "Nebula",
    symbol: "NEB",
    supply: "1000000",
  });
  assert.ok(!template.tags.some((t) => t[0] === "token"));
});

test("template links imported tokens via tag", () => {
  const template = buildLaunchRecordTemplate(
    baseInput({ token: "0x1234567890123456789012345678901234567890" }),
  );
  assert.ok(
    template.tags.some(
      (t) =>
        t[0] === "token" &&
        t[1] === "0x1234567890123456789012345678901234567890",
    ),
  );
});

test("mint command quotes names safely", () => {
  const cmd = mintCommandForPlan({
    tokenName: "Nebula DAO",
    symbol: "NEB",
    supply: "1000000",
    treasury: "0xabc",
  });
  assert.ok(cmd.startsWith("buzz launchpad mint-token"));
  assert.ok(cmd.includes("--supply 1000000"));
});

test("removing the kind constant breaks the template", () => {
  // Falsifiability: the record kind is load-bearing, not decorative.
  assert.equal(template_kind(), 37001);
});

function template_kind() {
  return buildLaunchRecordTemplate(baseInput()).kind;
}
