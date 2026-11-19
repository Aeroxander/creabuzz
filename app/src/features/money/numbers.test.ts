// biome-ignore-all lint/suspicious/noExplicitAny: the record is walked as loose JSON, the way a hostile one arrives
// biome-ignore-all lint/style/noNonNullAssertion: the example always carries these three times
import { describe, expect, it } from "vitest";
import {
  EXAMPLE_KEY,
  event,
  KEY,
  NOW,
  COORDINATE,
  parsedExample,
  raw,
  SERVER,
  type Json,
} from "../../../tests/helpers/numbers-v2-parse";
import {
  BACKER_EVM,
  chainIdentityV2,
  FOUNDER_EVM,
  numbersV2Content,
  STRANGER_EVM,
} from "../../../tests/helpers/numbers-v2-fixture";
import {
  dollarsText,
  freshnessOf,
  holdingHint,
  isRunner,
  parseNumbers,
  quietStateAt,
  sharesText,
  signsForRunner,
} from "./numbers";

describe("record version 2: the example", () => {
  it("parses, field by field", () => {
    const n = parsedExample();
    expect(n.version).toBe(2);
    expect(n.key).toBe(EXAMPLE_KEY);
    expect(n.chainId).toBe(31337);
    expect(n.playMoney).toBe(true);
    expect(n.contracts.treasury).toBe(
      raw().contracts && (raw().contracts as Json).treasury,
    );
    expect(n.contracts.pair).toBeNull();
    expect(n.money.pot).toBe(7_322_810_944n);
    expect(n.money.arriving).toBe(2_145_838_296n);
    expect(n.money.arrivalEnd).toBe(1_795_522_201);
    expect(n.allowance.pending).toEqual({
      ratePpm: 1500,
      proposedAt: 1_794_831_000,
      applicableAt: 1_795_435_800,
    });
    expect(n.runner.isPair).toBe(false);
    expect(n.runner.signers).toBeNull();
    expect(n.team.grants).toHaveLength(3);
    expect(n.team.grants[1]?.state).toBe("announced");
    expect(n.team.grants[1]?.forfeit?.byMember).toBe(true);
    expect(n.team.grants[2]?.cliff).toEqual({
      passed: false,
      endsAtIfActive: 1_799_841_900,
    });
    expect(n.agents).toHaveLength(1);
    expect(n.holders).toHaveLength(3);
    expect(n.holderCount).toBe(2);
    expect(n.limits.minJoin).toBe(1_000_000n);
    expect(n.firstBackedAt).toBe(1_785_938_400);
    expect(n.truncated).toBe(false);
  });

  it("does not carry the ledger block: it is for checks only and the app must not read it", () => {
    expect("ledger" in parsedExample()).toBe(false);
  });

  it("is believed for its project, and only for that project", () => {
    const content = numbersV2Content({ coordinate: COORDINATE, now: NOW });
    const mine = { coordinate: COORDINATE, chainKey: KEY };
    expect(parseNumbers(event(content), SERVER, mine)).not.toBeNull();
    const other = `37001:${"c".repeat(64)}:other`;
    expect(
      parseNumbers(event(content), SERVER, {
        coordinate: other,
        chainKey: chainIdentityV2(other).key,
      }),
    ).toBeNull();
    // Its own key under another project's chain key, or a record whose body names another key: no.
    expect(
      parseNumbers(
        event(content, { tags: [["d", EXAMPLE_KEY]] }),
        SERVER,
        mine,
      ),
    ).toBeNull();
    expect(
      parseNumbers(event({ ...content, key: EXAMPLE_KEY }), SERVER, mine),
    ).toBeNull();
    // A founder that did not make that launch.
    expect(
      parseNumbers(event({ ...content, founder: STRANGER_EVM }), SERVER, mine),
    ).toBeNull();
  });
});

describe("the example against RECORD-V2.md section 7.3, with the contracts' integer formulas", () => {
  const mulDiv = (a: bigint, b: bigint, c: bigint) => (a * b) / c;
  const big = (v: unknown) => BigInt(v as string);
  const rec = raw() as Record<string, any>;

  it("1: types and time order", () => {
    expect(rec.version).toBe(2);
    const amounts = (o: unknown): string[] =>
      typeof o === "string" && /^\d+$/.test(o)
        ? [o]
        : o && typeof o === "object"
          ? Object.values(o).flatMap(amounts)
          : [];
    for (const a of amounts(rec)) expect(a).toMatch(/^(0|[1-9]\d*)$/);
    const addresses = JSON.stringify(rec).match(/"0x[0-9a-fA-F]{40}"/g) ?? [];
    for (const a of addresses) expect(a).toBe(a.toLowerCase());
    expect(rec.launchedAt).toBeLessThanOrEqual(rec.asOf.time);
    expect(rec.asOf.time).toBeLessThanOrEqual(rec.builtAt);
  });

  it("2: the roll-forward of the ledger gives the settled figures", () => {
    const l = rec.ledger;
    const rate = BigInt(rec.allowance.ratePpm);
    const t = BigInt(rec.asOf.time);
    const last = BigInt(l.lastSettle);
    const end = BigInt(rec.clock.activeUntil ?? 0);
    const upto = t < end ? t : end;
    const dt = upto > last ? upto - last : 0n;
    let pot = big(l.pot);
    let box = big(l.box);
    let arriving = big(l.arriving);
    const cap = mulDiv(pot + box, rate * 7n, 1_000_000n);
    if (dt !== 0n && rate !== 0n) {
      const toBox = mulDiv(
        pot,
        rate * dt,
        1_000_000n * (BigInt(rec.unit) / 7n),
      );
      box += toBox;
      pot -= toBox;
    }
    if (box > cap) {
      pot += box - cap;
      box = cap;
    }
    if (arriving !== 0n) {
      const arrivalEnd = BigInt(l.arrivalEnd);
      const released =
        t >= arrivalEnd
          ? arriving
          : mulDiv(arriving, t - last, arrivalEnd - last);
      arriving -= released;
      pot += released;
    }
    expect(pot).toBe(big(rec.money.pot));
    expect(box).toBe(big(rec.allowance.box));
    expect(arriving).toBe(big(rec.money.arriving));
    expect(Number(l.activeSeconds) + Number(dt)).toBe(rec.clock.activeSeconds);
  });

  it("3: the box cap", () => {
    expect(
      mulDiv(
        big(rec.money.pot) + big(rec.allowance.box),
        BigInt(rec.allowance.ratePpm) * 7n,
        1_000_000n,
      ),
    ).toBe(big(rec.allowance.boxCap));
  });

  it("4: what one Share is worth", () => {
    const pot = big(rec.money.pot);
    const paidIn = big(rec.money.paidIn);
    const b = big(rec.shares.backers);
    const g = big(rec.shares.teamCounted);
    const a1 = pot < paidIn ? pot : paidIn;
    const e18 = 10n ** 18n;
    expect(mulDiv(e18, a1, b) + mulDiv(e18, pot - a1, b + g)).toBe(
      big(rec.value.leaveValue),
    );
    expect(mulDiv(e18, pot > paidIn ? pot - paidIn : 0n, b + g)).toBe(
      big(rec.value.teamValue),
    );
  });

  it("5: the dollars add up", () => {
    const m = rec.money;
    const buckets =
      big(m.pot) +
      big(rec.allowance.box) +
      big(m.arriving) +
      big(m.feesOwed) +
      big(m.locked) +
      big(m.notesOwed);
    expect(big(m.held)).toBe(buckets);
    const t = rec.totals;
    expect(big(t.joined) + big(t.outside)).toBe(
      big(t.fees) +
        big(t.tookOut) +
        big(t.drawn) +
        big(m.pot) +
        big(rec.allowance.box) +
        big(m.arriving) +
        big(m.locked) +
        big(m.notesOwed),
    );
  });

  it("6: Team Shares in hands and in the Vester make the counted Team Shares", () => {
    const t = rec.team;
    expect(big(t.inHands) + big(t.inVester)).toBe(big(rec.shares.teamCounted));
    expect(big(t.ungranted)).toBe(big(t.inVester) - big(t.promised));
    expect(big(t.ungranted)).toBeGreaterThanOrEqual(0n);
  });

  it("7: the holders' Shares add up to the supplies", () => {
    expect(rec.truncated).toBe(false);
    const holders = rec.holders as Json[];
    const sum = (field: string) =>
      holders.reduce((s, h) => s + big(h[field]), 0n);
    expect(sum("shares")).toBe(big(rec.shares.backers));
    expect(sum("teamShares")).toBe(big(rec.team.inHands));
    expect(holders.filter((h) => big(h.shares) > 0n)).toHaveLength(
      rec.holderCount,
    );
    expect(holders.filter((h) => big(h.teamShares) > 0n)).toHaveLength(
      rec.teamHolderCount,
    );
  });

  it("8: each grant", () => {
    const unit = BigInt(rec.unit);
    const vestLength = BigInt(rec.limits.vestUnits) * unit;
    const cliffLength = BigInt(rec.limits.cliffUnits) * unit;
    let promised = 0n;
    let burning = 0n;
    for (const g of rec.team.grants as Json[] & any[]) {
      expect(big(g.claimable)).toBe(big(g.vested) - big(g.claimed));
      const elapsed = BigInt(rec.clock.activeSeconds) - BigInt(g.startActive);
      if (g.state === "live" && g.kind === "normal") {
        const capped = elapsed > vestLength ? vestLength : elapsed;
        const expected =
          elapsed < cliffLength ? 0n : mulDiv(big(g.keeps), capped, vestLength);
        expect(big(g.vested)).toBe(expected);
        expect(g.cliff.passed).toBe(elapsed >= cliffLength);
        const cliffLeft = cliffLength - elapsed;
        expect(g.cliff.endsAtIfActive).toBe(
          cliffLeft > 0n ? rec.asOf.time + Number(cliffLeft) : null,
        );
        const fullLeft = vestLength - elapsed;
        expect(g.fullyVestedAtIfActive).toBe(
          fullLeft > 0n ? rec.asOf.time + Number(fullLeft) : null,
        );
      }
      const burn = g.forfeit ? big(g.forfeit.amount) : 0n;
      promised += big(g.keeps) - big(g.claimed) + burn;
      burning += burn;
    }
    expect(promised).toBe(big(rec.team.promised));
    expect(burning).toBe(big(rec.shares.announcedBurn));
  });

  it("9: the quiet times and the door", () => {
    const unit = rec.unit as number;
    expect(rec.quiet.quietFrom).toBe(rec.clock.activeUntil);
    expect(rec.clock.activeUntil).toBe(
      rec.clock.lastCheckIn + rec.limits.checkInWindowUnits * unit,
    );
    expect(rec.quiet.windableFrom).toBe(
      rec.clock.lastCheckIn + rec.limits.windDownUnits * unit,
    );
    expect(rec.quiet.dormantFrom).toBe(rec.clock.lastCheckIn + 13 * unit);
    expect(quietStateAt(parsedExample(), rec.asOf.time)).toBe(rec.quiet.state);
    expect(rec.door.openNow).toBe(
      rec.door.switchOn && rec.asOf.time < rec.door.shutsAt,
    );
  });

  it("10: the raise waiting and the money arriving", () => {
    expect(rec.allowance.pending.applicableAt).toBe(
      rec.allowance.pending.proposedAt + rec.unit,
    );
    expect(rec.money.arrivalEnd).toBeGreaterThan(rec.asOf.time);
  });
});

describe("what the screens ask of a record", () => {
  it("who runs the project, and who signs for a Pair", () => {
    const n = parsedExample();
    expect(isRunner(n, FOUNDER_EVM)).toBe(true);
    expect(isRunner(n, FOUNDER_EVM.toUpperCase().replace("0X", "0x"))).toBe(
      true,
    );
    expect(isRunner(n, BACKER_EVM)).toBe(false);
    expect(isRunner(n, null)).toBe(false);
    expect(signsForRunner(n, FOUNDER_EVM)).toBe(false);
    const pair = {
      ...n,
      runner: {
        address: `0x${"9".repeat(40)}`,
        isPair: true,
        signers: [FOUNDER_EVM, BACKER_EVM] as [string, string],
      },
    };
    expect(signsForRunner(pair, BACKER_EVM)).toBe(true);
    expect(signsForRunner(pair, STRANGER_EVM)).toBe(false);
  });

  it("the holders list is a hint: a cut list says nothing about someone it does not list", () => {
    const n = parsedExample();
    expect(holdingHint(n, [BACKER_EVM])).toMatchObject({
      listed: true,
      certain: true,
    });
    expect(holdingHint(n, [STRANGER_EVM])).toMatchObject({
      listed: false,
      certain: true,
    });
    const cut = { ...n, truncated: true };
    expect(holdingHint(cut, [STRANGER_EVM])).toMatchObject({
      listed: false,
      certain: false,
    });
    expect(holdingHint(cut, [BACKER_EVM])).toMatchObject({
      listed: true,
      certain: true,
    });
    // Several addresses of one person add up.
    const both = holdingHint(n, [
      BACKER_EVM,
      "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
    ]);
    expect(both.shares).toBe(
      490_000_000_000_000_000_000_000n + 176_561_850_392_687_662_002_152n,
    );
  });

  it("the state's word follows the three times", () => {
    const n = parsedExample();
    expect(quietStateAt(n, n.quiet.quietFrom! - 1)).toBe("active");
    expect(quietStateAt(n, n.quiet.quietFrom!)).toBe("quiet");
    expect(quietStateAt(n, n.quiet.dormantFrom!)).toBe("dormant");
    expect(quietStateAt(n, n.quiet.windableFrom! - 1)).toBe("dormant");
    expect(quietStateAt(n, n.quiet.windableFrom!)).toBe("may_wind_down");
    const wound = { ...n, windDown: { kind: 1 as const, at: n.builtAt } };
    expect(quietStateAt(wound, n.builtAt + 10 ** 9)).toBe("wound_down");
  });

  it("how old a record is: fresh to 3R+60 seconds, 'as of' to a day, stale after", () => {
    const n = parsedExample(); // R = 600: the limit is 1,860
    expect(freshnessOf(n, n.builtAt)).toEqual({ level: "fresh", ageSecs: 0 });
    expect(freshnessOf(n, n.builtAt - 500).level).toBe("fresh"); // a clock behind the server's counts as age 0
    expect(freshnessOf(n, n.builtAt + 1_860).level).toBe("fresh");
    expect(freshnessOf(n, n.builtAt + 1_861).level).toBe("as-of");
    expect(freshnessOf(n, n.builtAt + 86_400).level).toBe("as-of");
    expect(freshnessOf(n, n.builtAt + 86_401).level).toBe("stale");
    const slow = { ...n, refreshEverySecs: 3600 };
    expect(freshnessOf(slow, n.builtAt + 10_860).level).toBe("fresh");
    expect(freshnessOf(slow, n.builtAt + 10_861).level).toBe("as-of");
  });

  it("words for amounts", () => {
    expect(dollarsText(7_322_810_944n)).toBe("7,322.81");
    expect(dollarsText(1_000_000n)).toBe("1");
    expect(sharesText(490_000_000_000_000_000_000_000n)).toBe("490,000");
  });
});
