// The press that lets people on other apps message a person here: it adds this server to their public message-server list and
// takes it off again, keeps every server another app put there, says plainly that the list is public, and writes nothing from a
// list that could not be read.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draw, NOW, reset, stored, world } from "../safety/social-harness";

vi.mock(
  "../../lib/relay",
  async () => (await import("../safety/social-harness")).relayMock,
);
vi.mock(
  "../../lib/account",
  async () => (await import("../safety/social-harness")).accountMock,
);
vi.mock(
  "@creaton/core/client/identity.ts",
  async () => (await import("../safety/social-harness")).identityMock,
);

import { MessageServerCard } from "./MessageServerCard";

const HERE = "ws://localhost:3000";
let person = 0;
beforeEach(() => {
  reset();
  // The list queue remembers what this page last wrote for a person, so each test is its own person.
  person += 1;
  world.me = person.toString(16).padStart(64, "a");
});
afterEach(cleanup);

const toggle = async () =>
  (await screen.findByTestId("message-server-toggle")) as HTMLButtonElement;

describe("message servers", () => {
  it("says the list is public, and turning on adds this server beside the ones another app put there", async () => {
    stored(
      world.me,
      10050,
      [
        ["relay", "wss://other.test"],
        ["alt", "mine"],
      ],
      "",
      NOW - 100,
    );
    draw(<MessageServerCard />);
    expect((await screen.findByTestId("message-server")).textContent).toMatch(
      /public note saying which server/,
    );
    expect((await toggle()).textContent).toBe("Turn on");
    fireEvent.click(await toggle());
    await waitFor(() => expect(world.published).toHaveLength(1));
    const list = world.published[0];
    expect(list.kind).toBe(10050);
    expect(list.tags).toEqual([
      ["relay", "wss://other.test"],
      ["alt", "mine"],
      ["relay", HERE],
    ]);
    expect(
      await screen.findByText("Other apps can now reach you here"),
    ).toBeTruthy();
    expect((await toggle()).textContent).toBe("Turn off");
    expect(screen.getByTestId("message-server").textContent).toMatch(
      /Your list of message servers is public/,
    );
  });

  it("turning off takes away only this server", async () => {
    stored(
      world.me,
      10050,
      [
        ["relay", "wss://other.test"],
        ["relay", HERE],
      ],
      "",
      NOW - 100,
    );
    draw(<MessageServerCard />);
    await waitFor(async () =>
      expect((await toggle()).textContent).toBe("Turn off"),
    );
    fireEvent.click(await toggle());
    await waitFor(() => expect(world.published).toHaveLength(1));
    expect(world.published[0].tags).toEqual([["relay", "wss://other.test"]]);
  });

  it("with no list yet, turning on makes a list of this server alone", async () => {
    draw(<MessageServerCard />);
    fireEvent.click(await toggle());
    await waitFor(() => expect(world.published).toHaveLength(1));
    expect(world.published[0].tags).toEqual([["relay", HERE]]);
  });

  it("a list that cannot be read is not known, writes nothing, and offers another try", async () => {
    world.failKinds = [10050];
    draw(<MessageServerCard />);
    expect((await screen.findByTestId("message-server")).textContent).toMatch(
      /Could not check/,
    );
    expect(screen.queryByTestId("message-server-toggle")).toBeNull();
    world.failKinds = [];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await toggle()).textContent).toBe("Turn on");
    expect(world.published).toHaveLength(0);
  });

  it("a refused write is said, and the card stays as it was", async () => {
    world.refuse = "restricted: not now";
    draw(<MessageServerCard />);
    fireEvent.click(await toggle());
    expect(await screen.findByText(/not now/i)).toBeTruthy();
    expect((await toggle()).textContent).toBe("Turn on");
  });
});
