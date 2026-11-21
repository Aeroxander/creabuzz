// The writing box: words and pictures. A picture is made ready on the phone (its location and every other hidden detail gone),
// described for screen readers, and sent only when the post is sent; a failed upload loses nothing; a quote needs words of its
// own; an edit sends the changed post first and then takes the old one down.
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contains,
  LOCATION_TEXT,
  photoWithLocation,
} from "../pictures/photo-fixture";
import {
  ANA,
  draw,
  NOW,
  note,
  profile,
  reset,
  world,
} from "../safety/social-harness";

const uploaded: { bytes: Uint8Array; mime: string }[] = [];
const uploadControl = { failAt: null as number | null, count: 0 };

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
vi.mock("@tanstack/react-router", async (actual) =>
  (await import("../safety/social-harness")).routerMock(actual),
);
vi.mock("../../lib/upload", () => ({
  uploadPicture: async (bytes: Uint8Array, mime: string) => {
    uploadControl.count += 1;
    if (uploadControl.failAt === uploadControl.count)
      throw new Error("media service temporarily unavailable");
    uploaded.push({ bytes, mime });
    const sha = uploaded.length.toString(16).padStart(64, "0");
    return {
      url: `http://localhost:3000/media/${sha}.jpg`,
      sha256: sha,
      size: bytes.length,
      type: mime,
    };
  },
}));
// The real cleaning runs; only the browser's drawing is replaced, by one whose encoder keeps the photo's hidden details.
vi.mock("../pictures/clean-picture", async (importActual) => {
  const actual =
    await importActual<typeof import("../pictures/clean-picture")>();
  return {
    ...actual,
    cleanPicture: (file: File) =>
      actual.cleanPicture(file, {
        render: async () => ({
          width: 800,
          height: 600,
          hasAlpha: false,
          encode: async () => photoWithLocation(),
        }),
      }),
  };
});

import { ComposerSheet } from "./Composer";

beforeEach(() => {
  reset();
  uploaded.length = 0;
  uploadControl.failAt = null;
  uploadControl.count = 0;
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => undefined;
});
afterEach(cleanup);

const jpeg = (name = "photo.jpg") =>
  new File([new Uint8Array(2000)], name, { type: "image/jpeg" });

async function pick(...files: File[]) {
  fireEvent.change(await screen.findByTestId("composer-file"), {
    target: { files },
  });
}

const open = (props: Partial<Parameters<typeof ComposerSheet>[0]> = {}) =>
  draw(<ComposerSheet onOpenChange={() => undefined} open {...props} />);

describe("a locked passkey account in the writing box", () => {
  it("is told to unlock with a press inside the box, where the bar at the top is covered, and keeps what it typed", async () => {
    world.passkeyLocked = true;
    open();
    fireEvent.change(await screen.findByTestId("composer-text"), {
      target: { value: "Typed before the reload" },
    });
    expect(screen.getByTestId("composer-locked").textContent).toMatch(
      /^Unlock with your passkey to post\. What you typed is kept\.Unlock$/,
    );
    expect(screen.getByTestId("composer-unlock")).toBeTruthy();
    expect(
      (screen.getByTestId("composer-text") as HTMLTextAreaElement).value,
    ).toBe("Typed before the reload");
  });

  it("an unlocked account is told nothing", async () => {
    open();
    await screen.findByTestId("composer-text");
    expect(screen.queryByTestId("composer-locked")).toBeNull();
  });
});

describe("pictures in a post", () => {
  it("sends each picture clean: no location in the bytes that are uploaded, and the post carries the description", async () => {
    open();
    fireEvent.change(await screen.findByTestId("composer-text"), {
      target: { value: "Lit tonight #lamps" },
    });
    await pick(jpeg());
    const alt = await screen.findByLabelText("Describe picture 1");
    fireEvent.change(alt, { target: { value: "A red lamp on a desk" } });
    fireEvent.click(screen.getByTestId("composer-send"));
    await waitFor(() => expect(world.published).toHaveLength(1));
    // What went up carries none of what the file said about where it was taken.
    expect(uploaded).toHaveLength(1);
    expect(contains(photoWithLocation(), LOCATION_TEXT)).toBe(true);
    for (const text of ["GPS", "Exif", "xmpmeta", "SomePhone", "ICC_PROFILE"])
      expect(contains(uploaded[0].bytes, text)).toBe(false);
    const post = world.published[0];
    expect(post.kind).toBe(1);
    expect(post.content).toMatch(
      /^Lit tonight #lamps\nhttp:\/\/localhost:3000\/media\/[0-9a-f]{64}\.jpg$/,
    );
    const imeta = post.tags.find((t) => t[0] === "imeta");
    expect(imeta).toContain("alt A red lamp on a desk");
    expect(imeta?.some((f) => f.startsWith("dim 800x600"))).toBe(true);
    expect(post.tags).toContainEqual(["t", "lamps"]);
  });

  it("asks for a description, says what leaving it empty means, and still posts", async () => {
    open();
    await pick(jpeg());
    expect(await screen.findByLabelText("Describe picture 1")).toBeTruthy();
    expect(screen.getByText(/No description yet/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("composer-send"));
    await waitFor(() => expect(world.published).toHaveLength(1));
    expect(
      world.published[0].tags
        .find((t) => t[0] === "imeta")
        ?.some((f) => f.startsWith("alt ")),
    ).toBe(false);
  });

  it("holds at four pictures: the press is turned off and a longer pick says why", async () => {
    open();
    await pick(
      jpeg("1.jpg"),
      jpeg("2.jpg"),
      jpeg("3.jpg"),
      jpeg("4.jpg"),
      jpeg("5.jpg"),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("draft-picture")).toHaveLength(4),
    );
    expect((await screen.findByTestId("composer-problem")).textContent).toBe(
      "A post can have up to 4 pictures.",
    );
    const add = screen.getByTestId("composer-add-picture") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.textContent).toContain("Up to 4 pictures");
    // A picture can be taken out again, which frees the press.
    fireEvent.click(screen.getAllByTestId("draft-picture-remove")[0]);
    await waitFor(() =>
      expect(screen.getAllByTestId("draft-picture")).toHaveLength(3),
    );
    expect(
      (screen.getByTestId("composer-add-picture") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("turns away a file that is not a picture in words, and keeps what was typed", async () => {
    open();
    fireEvent.change(await screen.findByTestId("composer-text"), {
      target: { value: "Words" },
    });
    await pick(new File(["x"], "notes.pdf", { type: "application/pdf" }));
    expect((await screen.findByTestId("composer-problem")).textContent).toMatch(
      /not a picture/,
    );
    expect(screen.queryAllByTestId("draft-picture")).toHaveLength(0);
    expect(
      (screen.getByTestId("composer-text") as HTMLTextAreaElement).value,
    ).toBe("Words");
  });

  it("a failed upload says so, posts nothing, keeps the words, the pictures and their descriptions, and a retry sends only what is left", async () => {
    uploadControl.failAt = 2;
    open();
    fireEvent.change(await screen.findByTestId("composer-text"), {
      target: { value: "Two pictures" },
    });
    await pick(jpeg("1.jpg"), jpeg("2.jpg"));
    await waitFor(() =>
      expect(screen.getAllByTestId("draft-picture")).toHaveLength(2),
    );
    fireEvent.change(screen.getByLabelText("Describe picture 2"), {
      target: { value: "Second" },
    });
    fireEvent.click(screen.getByTestId("composer-send"));
    const problem = await screen.findByTestId("composer-problem");
    expect(problem.textContent).toMatch(
      /did not upload, so nothing was posted/,
    );
    expect(problem.textContent).toMatch(
      /Uploads aren't working on this server just now/,
    );
    expect(world.published).toHaveLength(0);
    expect(
      (screen.getByTestId("composer-text") as HTMLTextAreaElement).value,
    ).toBe("Two pictures");
    expect(screen.getAllByTestId("draft-picture")).toHaveLength(2);
    expect(
      (screen.getByLabelText("Describe picture 2") as HTMLInputElement).value,
    ).toBe("Second");
    // Again: the first picture is already up and is not sent twice.
    fireEvent.click(screen.getByTestId("composer-send"));
    await waitFor(() => expect(world.published).toHaveLength(1));
    expect(uploaded).toHaveLength(2);
    expect(
      world.published[0].tags.filter((t) => t[0] === "imeta"),
    ).toHaveLength(2);
  });

  it("a post refused by the server keeps everything too", async () => {
    world.refuse = "restricted: not now";
    open();
    fireEvent.change(await screen.findByTestId("composer-text"), {
      target: { value: "Words" },
    });
    await pick(jpeg());
    await screen.findByLabelText("Describe picture 1");
    fireEvent.click(screen.getByTestId("composer-send"));
    expect(
      (await screen.findByTestId("composer-problem")).textContent,
    ).toBeTruthy();
    expect(screen.getAllByTestId("draft-picture")).toHaveLength(1);
    expect(
      (screen.getByTestId("composer-text") as HTMLTextAreaElement).value,
    ).toBe("Words");
  });

  it("a picture alone is a post; nothing at all is not", async () => {
    open();
    const send = (await screen.findByTestId(
      "composer-send",
    )) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await pick(jpeg());
    await screen.findByLabelText("Describe picture 1");
    expect(send.disabled).toBe(false);
  });
});

describe("quoting a post", () => {
  it("asks for words of your own, shows whose post is quoted, and sends the quote", async () => {
    profile(ANA, "Ana");
    const quoted = note(ANA, "The lamp is lit", NOW - 50);
    open({ quote: { id: quoted.id, pubkey: ANA }, title: "Quote this post" });
    const box = await screen.findByTestId("composer-quoting");
    expect(await within(box).findByText("The lamp is lit")).toBeTruthy();
    expect(await within(box).findByText("Ana")).toBeTruthy();
    const send = screen.getByTestId("composer-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("composer-text"), {
      target: { value: "Agreed" },
    });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(world.published).toHaveLength(1));
    const post = world.published[0];
    expect(post.tags).toContainEqual(["q", quoted.id, "", ANA]);
    expect(post.tags).toContainEqual(["p", ANA]);
    expect(post.content).toMatch(/^Agreed\n\nnostr:nevent1/);
  });
});

describe("editing a post", () => {
  it("says what an edit does, starts from the post's words, sends the changed post first and then takes the old one down", async () => {
    const old = note(world.me, "Lit tonight #lamps", NOW - 50, [
      ["t", "lamps"],
    ]);
    open({ edit: old, title: "Edit your post" });
    expect(await screen.findByTestId("composer-edit-note")).toBeTruthy();
    expect(screen.getByTestId("composer-edit-note").textContent).toMatch(
      /Likes on the old one do not carry over/,
    );
    const box = screen.getByTestId("composer-text") as HTMLTextAreaElement;
    expect(box.value).toBe("Lit tonight #lamps");
    fireEvent.change(box, {
      target: { value: "Lit tonight and tomorrow #lamps" },
    });
    fireEvent.click(screen.getByTestId("composer-send"));
    await waitFor(() => expect(world.published).toHaveLength(2));
    const [changed, removal] = world.published;
    expect(changed.kind).toBe(1);
    expect(changed.content).toBe("Lit tonight and tomorrow #lamps");
    expect(removal.kind).toBe(5);
    expect(removal.tags).toEqual([
      ["e", old.id],
      ["k", "1"],
    ]);
  });

  it("keeps the post's pictures and its quote when only the words change", async () => {
    const url = `http://localhost:3000/media/${"a".repeat(64)}.jpg`;
    const quoted = "b".repeat(64);
    const old = note(world.me, `Hello\n${url}`, NOW - 50, [
      ["imeta", `url ${url}`, "alt A lamp"],
      ["q", quoted, "", ANA],
      ["p", ANA],
    ]);
    open({ edit: old });
    expect(
      ((await screen.findByLabelText("Describe picture 1")) as HTMLInputElement)
        .value,
    ).toBe("A lamp");
    fireEvent.change(screen.getByTestId("composer-text"), {
      target: { value: "Hello again" },
    });
    fireEvent.click(screen.getByTestId("composer-send"));
    await waitFor(() => expect(world.published).toHaveLength(2));
    const changed = world.published[0];
    expect(changed.tags).toContainEqual(["q", quoted, "", ANA]);
    expect(changed.tags.find((t) => t[0] === "imeta")).toContain("alt A lamp");
    expect(changed.content).toContain(url);
    expect(uploaded).toHaveLength(0);
  });

  it("if the old post cannot be taken down the changed one is still up, and it says so", async () => {
    const old = note(world.me, "Old", NOW - 50);
    const sent: string[] = [];
    const real = world.refuse;
    open({ edit: old });
    fireEvent.change(await screen.findByTestId("composer-text"), {
      target: { value: "New" },
    });
    // The server refuses only the deletion.
    const { relayMock } = await import("../safety/social-harness");
    const publish = relayMock.publishAsUser;
    relayMock.publishAsUser = async (template) => {
      sent.push(String(template.kind));
      if (template.kind === 5) throw new Error("restricted: not now");
      return publish(template);
    };
    fireEvent.click(screen.getByTestId("composer-send"));
    await waitFor(() => expect(sent).toEqual(["1", "5"]));
    expect(world.published).toHaveLength(1);
    expect(world.published[0].content).toBe("New");
    expect(
      await screen.findByText(/the old one could not be taken down/),
    ).toBeTruthy();
    relayMock.publishAsUser = publish;
    world.refuse = real;
  });
});
