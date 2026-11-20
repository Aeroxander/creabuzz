// Whether the app offers a person a place to write (plan 4.2 and 4.7), as the server's own rule reads it: a link first, then
// holding above a floor in Shares (a Share's price never matters), a Team grant with something to claim, the unit after taking
// out, then the team's stop. The server's word is final; this decides only what is offered.
import { describe, expect, it } from "vitest";
import {
  graceEnd,
  RENEW_WITHIN,
  ROOM_MIN_SHARES,
  type StandingInput,
  standingOf,
} from "./room-standing";

const NOW = 1_800_000_000;
const UNIT = 7 * 86_400;
const base: StandingInput = {
  me: "a".repeat(64),
  holds: { shares: ROOM_MIN_SHARES, team: 0n },
  claimable: false,
  tookOutAt: null,
  unit: UNIT,
  now: NOW,
  link: {
    state: "linked",
    address: `0x${"11".repeat(20)}`,
    expires: NOW + 200 * 86_400,
  },
  phoneUnsupported: false,
  mutedUntil: null,
};
const of = (patch: Partial<StandingInput>) => standingOf({ ...base, ...patch });

describe("who is offered a place to write", () => {
  it("a holder with a linked wallet writes", () => {
    expect(of({})).toEqual({ kind: "write", graceEndsAt: null, renewBy: null });
  });

  it("nobody signed in is read-only, and a person whose holding is not known yet is told so", () => {
    expect(of({ me: null }).kind).toBe("signed-out");
    expect(of({ holds: undefined }).kind).toBe("checking");
    expect(of({ link: undefined }).kind).toBe("checking");
  });

  it("holding is judged at the floor, in Shares and not dollars: one wei short is out, the floor itself is in, for both tokens", () => {
    expect(of({ holds: { shares: ROOM_MIN_SHARES - 1n, team: 0n } }).kind).toBe(
      "not-holding",
    );
    expect(of({ holds: { shares: 1n, team: 0n } }).kind).toBe("not-holding");
    expect(of({ holds: { shares: 0n, team: ROOM_MIN_SHARES } }).kind).toBe(
      "write",
    );
    expect(of({ holds: { shares: 0n, team: ROOM_MIN_SHARES - 1n } }).kind).toBe(
      "not-holding",
    );
    expect(of({ holds: null }).kind).toBe("not-holding");
  });

  it("a Team grant with something left to claim counts as holding; one with nothing left does not", () => {
    expect(of({ holds: { shares: 0n, team: 0n }, claimable: true }).kind).toBe(
      "write",
    );
    expect(of({ holds: { shares: 0n, team: 0n }, claimable: false }).kind).toBe(
      "not-holding",
    );
  });

  it("a person who took out keeps writing for one unit, and then is read-only", () => {
    const left = { holds: { shares: 0n, team: 0n } };
    const inside = of({ ...left, tookOutAt: NOW - UNIT + 60 });
    expect(inside).toEqual({
      kind: "write",
      graceEndsAt: NOW + 60,
      renewBy: null,
    });
    expect(of({ ...left, tookOutAt: NOW - UNIT }).kind).toBe("not-holding");
    expect(of({ ...left, tookOutAt: NOW - UNIT - 1 }).kind).toBe("not-holding");
    expect(of({ ...left, tookOutAt: null }).kind).toBe("not-holding");
    // A holder who also took some out is a holder: no unit is counted.
    expect(of({ tookOutAt: NOW - 10 })).toEqual({
      kind: "write",
      graceEndsAt: null,
      renewBy: null,
    });
  });

  it("the grace is the unit of the project, and a project with no unit has none", () => {
    expect(graceEnd({ ...base, tookOutAt: NOW - 5, unit: 0 })).toBeNull();
    expect(graceEnd({ ...base, tookOutAt: NOW - 5, unit: 100 })).toBe(NOW + 95);
  });

  it("a holder whose link is missing, expired or cannot be checked is asked to confirm the account", () => {
    expect(of({ link: { state: "none" } })).toEqual({
      kind: "needs-link",
      expired: false,
    });
    expect(of({ link: { state: "expired" } })).toEqual({
      kind: "needs-link",
      expired: true,
    });
    expect(of({ link: { state: "unchecked" } })).toEqual({
      kind: "needs-link",
      expired: false,
    });
    // A stranger is not asked to confirm anything: the link is not what is missing.
    expect(of({ link: { state: "none" }, holds: null }).kind).toBe(
      "not-holding",
    );
  });

  it("a phone account on a server that cannot check its link is told so, whatever else holds", () => {
    expect(of({ phoneUnsupported: true }).kind).toBe("phone-unsupported");
    expect(of({ phoneUnsupported: true, holds: null }).kind).toBe(
      "not-holding",
    );
  });

  it("the team's stop is in force until it ends", () => {
    expect(of({ mutedUntil: NOW + 5 })).toEqual({
      kind: "muted",
      until: NOW + 5,
    });
    expect(of({ mutedUntil: NOW }).kind).toBe("write");
    expect(of({ mutedUntil: NOW - 5 }).kind).toBe("write");
  });

  it("a link that ends within 30 days is asked to be renewed, and one that ends later is not", () => {
    const ends = NOW + RENEW_WITHIN - 1;
    expect(
      of({ link: { state: "linked", address: "0x1", expires: ends } }),
    ).toEqual({
      kind: "write",
      graceEndsAt: null,
      renewBy: ends,
    });
    expect(
      of({
        link: { state: "linked", address: "0x1", expires: NOW + RENEW_WITHIN },
      }),
    ).toMatchObject({ renewBy: null });
  });
});
