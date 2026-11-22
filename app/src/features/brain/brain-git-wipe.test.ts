// The copy of a brain that was downloaded but cannot be read is wiped, like one that did not download: nothing of a private
// brain is left in the browser's file store. The git library and the file store are stand-ins that count what is done to them.
import { beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
  stores: [] as Array<{ wipe: boolean }>,
  resolveFails: false,
}));

vi.mock("@creaton/core/client/nip98.ts", () => ({
  makeNip98AuthHeader: async () => "Nostr test",
}));
vi.mock("@creaton/core/client/relay-url.ts", () => ({
  relayHttpBaseUrl: () => "https://server.example",
}));
vi.mock("@creaton/core/client/git-http.ts", () => ({
  withGitDeadline: async (run: (http: unknown) => Promise<unknown>) =>
    run({ request: async () => ({}) }),
}));
vi.mock("@isomorphic-git/lightning-fs", () => ({
  default: class {
    constructor(_name: string, options: { wipe: boolean }) {
      world.stores.push(options);
    }
  },
}));
vi.mock("isomorphic-git", () => ({
  clone: async () => undefined,
  resolveRef: async () => {
    if (world.resolveFails) throw new Error("no HEAD in this copy");
    return "a".repeat(40);
  },
}));

import { gitTools } from "./brain-git";

const repo = { owner: "b".repeat(64), id: "brain" } as never;

beforeEach(() => {
  world.stores = [];
  world.resolveFails = false;
});

describe("the brain's copy in the browser's file store", () => {
  it("is made fresh once for a read that works", async () => {
    await gitTools.open(repo);
    expect(world.stores).toEqual([{ wipe: true }]);
  });

  it("is wiped again when it downloaded but cannot be read, and the error still reaches the person", async () => {
    world.resolveFails = true;
    await expect(gitTools.open(repo)).rejects.toThrow("no HEAD in this copy");
    // the fresh store for the read, then the wipe
    expect(world.stores).toEqual([{ wipe: true }, { wipe: true }]);
  });
});
