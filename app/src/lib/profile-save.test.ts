import { beforeEach, describe, expect, it, vi } from "vitest";

const relay = vi.hoisted(() => ({
  readLatest: vi.fn(),
  publishAsUser: vi.fn(),
}));
vi.mock("./relay", () => relay);

import { saveProfile } from "./profile-save";

const ME = "a".repeat(64);

function profileEvent(content: string) {
  return {
    id: "1".repeat(64),
    pubkey: ME,
    kind: 0,
    created_at: 1,
    tags: [],
    content,
    sig: "2".repeat(128),
  };
}

function published(): Record<string, unknown> {
  const template = relay.publishAsUser.mock.calls[0][0] as { content: string };
  return JSON.parse(template.content) as Record<string, unknown>;
}

beforeEach(() => {
  relay.readLatest.mockReset();
  relay.publishAsUser.mockReset();
  relay.publishAsUser.mockResolvedValue(undefined);
});

describe("saveProfile", () => {
  it("publishes nothing when the profile cannot be read (a timeout must not wipe it)", async () => {
    relay.readLatest.mockRejectedValue(new Error("timed out"));
    await expect(
      saveProfile(ME, { name: "Fay" }, { expectExisting: true }),
    ).rejects.toThrow("nothing was changed");
    await expect(saveProfile(ME, { name: "Fay" })).rejects.toThrow(
      "nothing was changed",
    );
    expect(relay.publishAsUser).not.toHaveBeenCalled();
  });

  it("publishes nothing when a profile was expected and the read found none", async () => {
    relay.readLatest.mockResolvedValue(null);
    await expect(
      saveProfile(ME, { name: "Fay" }, { expectExisting: true }),
    ).rejects.toThrow("nothing was changed");
    expect(relay.publishAsUser).not.toHaveBeenCalled();
  });

  it("starts from empty only where no profile is expected (sign-up)", async () => {
    relay.readLatest.mockResolvedValue(null);
    await saveProfile(ME, { name: "Fay" });
    expect(published()).toEqual({ name: "Fay", display_name: "Fay" });
  });

  it("keeps every other field of the newest profile", async () => {
    relay.readLatest.mockResolvedValue(
      profileEvent(
        JSON.stringify({
          name: "Old",
          picture: "https://x.example/p.png",
          lud16: "fay@x.example",
          about: "old about",
        }),
      ),
    );
    await saveProfile(
      ME,
      { name: " Fay ", about: "" },
      { expectExisting: true },
    );
    expect(published()).toEqual({
      name: "Fay",
      display_name: "Fay",
      picture: "https://x.example/p.png",
      lud16: "fay@x.example",
    });
  });
});
