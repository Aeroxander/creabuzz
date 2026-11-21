import { expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { PressCounter } from "../helpers/press-counter";
import { createMockRelay, PREVIEW_PORT } from "./mock-relay";
import { event, install, now } from "./helpers/world";
import { FAY, READER, READER_KEY, seedSocial } from "./helpers/social-world";

/**
 * Pictures in posts, at phone width (360), in a real browser: a photo that carries a location goes up with none of it in the
 * bytes (and with none of any other hidden detail), the picture is described for screen readers, drawn from this server with a
 * signed read, a failed upload loses nothing, a post's pictures can be hidden, and nothing is ever asked of another website.
 */
test.use({ viewport: { width: 360, height: 740 } });

const ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`;
/** The location this spec puts in its photo: 51 degrees 30 minutes 26.64 seconds north. */
const LATITUDE = [51, 1, 30, 1, 2664, 100];

const le32 = (n: number) => [
  n & 255,
  (n >> 8) & 255,
  (n >> 16) & 255,
  (n >> 24) & 255,
];

/** An EXIF block with a real GPS entry (the shape a phone writes), as the bytes of a JPEG's APP1 segment. */
function exifWithLocation(): Buffer {
  const gpsAt = 26;
  const rationalsAt = gpsAt + 2 + 2 * 12 + 4;
  const tiff = [
    0x49,
    0x49,
    0x2a,
    0x00,
    ...le32(8),
    // IFD0: one entry, the pointer to the GPS block.
    1,
    0,
    0x25,
    0x88,
    4,
    0,
    ...le32(1),
    ...le32(gpsAt),
    ...le32(0),
    // The GPS block: the latitude's side (N) and the latitude itself.
    2,
    0,
    1,
    0,
    2,
    0,
    ...le32(2),
    0x4e,
    0,
    0,
    0,
    2,
    0,
    5,
    0,
    ...le32(3),
    ...le32(rationalsAt),
    ...le32(0),
    ...LATITUDE.flatMap(le32),
  ];
  const payload = [...Buffer.from("Exif\0\0", "latin1"), ...tiff];
  return Buffer.from([
    0xff,
    0xe1,
    (payload.length + 2) >> 8,
    (payload.length + 2) & 255,
    ...payload,
  ]);
}

/** A picture the browser made, with a camera block, a comment and a location written into it after the start marker. */
async function photoWithLocation(page: Page): Promise<Buffer> {
  const plain = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 48;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("no canvas");
        context.fillStyle = "#c33";
        context.fillRect(0, 0, 64, 48);
        canvas.toBlob(
          (blob) =>
            blob
              ?.arrayBuffer()
              .then((b) => resolve(Array.from(new Uint8Array(b)))),
          "image/jpeg",
          0.9,
        );
      }),
  );
  const bytes = Buffer.from(plain);
  const camera = Buffer.from([
    0xff,
    0xe1,
    0,
    20,
    ...Buffer.from("http://ns.adobe.com/", "latin1").subarray(0, 18),
  ]);
  const comment = Buffer.from([
    0xff,
    0xfe,
    0,
    17,
    ...Buffer.from("taken by someone", "latin1").subarray(0, 15),
  ]);
  return Buffer.concat([
    bytes.subarray(0, 2),
    exifWithLocation(),
    camera,
    comment,
    bytes.subarray(2),
  ]);
}

/** A JPEG's markers, in order, by a plain scan (an independent reading of the bytes, not the app's). */
function markersOf(bytes: Buffer): number[] {
  const out: number[] = [];
  let i = 2;
  out.push(0xd8);
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (
      marker === 0xff ||
      marker === 0x00 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    out.push(marker);
    if (marker === 0xd9) break;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    i += 2 + length;
    if (marker === 0xda) {
      // The picture's own data runs on to the next real marker.
      while (
        i + 1 < bytes.length &&
        !(
          bytes[i] === 0xff &&
          bytes[i + 1] !== 0x00 &&
          !(bytes[i + 1] >= 0xd0 && bytes[i + 1] <= 0xd7)
        )
      )
        i += 1;
    }
  }
  return out;
}

interface Stored {
  sha: string;
  bytes: Buffer;
}

/** This server's media store, as the page sees it: uploads are kept, reads need a signed permit. */
async function mediaStore(
  page: Page,
  options: { failFirstUpload?: string } = {},
) {
  const uploads: { body: Buffer; headers: Record<string, string> }[] = [];
  const reads: { url: string; authorization: string | undefined }[] = [];
  const kept = new Map<string, Stored>();
  let attempts = 0;
  await page.route("**/upload", async (route) => {
    const request = route.request();
    attempts += 1;
    if (options.failFirstUpload && attempts === 1) {
      await route.fulfill({
        status: 503,
        json: { error: options.failFirstUpload },
      });
      return;
    }
    const body = request.postDataBuffer() ?? Buffer.alloc(0);
    uploads.push({ body, headers: request.headers() });
    const sha = request.headers()["x-sha-256"] ?? "";
    kept.set(sha, { sha, bytes: body });
    await route.fulfill({
      status: 200,
      json: {
        url: `${ORIGIN}/media/${sha}.jpg`,
        sha256: sha,
        size: body.length,
        type: "image/jpeg",
      },
    });
  });
  await page.route("**/media/**", async (route) => {
    const url = new URL(route.request().url());
    reads.push({
      url: url.pathname,
      authorization: route.request().headers().authorization,
    });
    const sha = url.pathname.replace(/^\/media\//, "").replace(/\..*$/, "");
    const found = kept.get(sha);
    if (!found) {
      await route.fulfill({ status: 404, body: "" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: found.bytes,
    });
  });
  return { uploads, reads, kept };
}

test("a photo with a location goes up with none of it, described, and is drawn from this server", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  const store = await mediaStore(page);
  const requested: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.origin !== ORIGIN &&
      !url.protocol.startsWith("ws") &&
      url.protocol.startsWith("http")
    )
      requested.push(request.url());
  });
  await install(page, relay, READER_KEY);
  await page.goto("/");
  const photo = await photoWithLocation(page);
  // The fixture really does carry a location, a camera block and a comment.
  expect(photo.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(true);
  expect(photo.includes(Buffer.from(LATITUDE.flatMap(le32)))).toBe(true);
  expect(markersOf(photo)).toContain(0xe1);
  expect(markersOf(photo)).toContain(0xfe);

  const path = new PressCounter();
  await path.press(page.getByTestId("home-compose"), "Write a post");
  await path.type(
    page.getByTestId("composer-text"),
    "Lit tonight #lamps",
    "Words",
  );
  const chooser = page.waitForEvent("filechooser");
  await path.press(page.getByTestId("composer-add-picture"), "Add a picture");
  await (await chooser).setFiles({
    name: "IMG_0001.jpg",
    mimeType: "image/jpeg",
    buffer: photo,
  });
  const alt = page.getByLabel("Describe picture 1");
  await expect(alt).toBeVisible();
  await path.type(alt, "A red square", "Description");
  await expectAccessible(page, "writing box with a picture");
  await expectNoSidewaysScroll(page, "writing box with a picture");
  await path.press(page.getByTestId("composer-send"), "Post");
  expect([path.counts().presses, path.counts().fields]).toEqual([3, 2]);

  // What went up: one file, a JPEG, with none of what the photo carried.
  await expect.poll(() => store.uploads.length).toBe(1);
  const sent = store.uploads[0].body;
  expect([...sent.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  expect(sent.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(false);
  expect(sent.includes(Buffer.from(LATITUDE.flatMap(le32)))).toBe(false);
  expect(sent.includes(Buffer.from("taken by someone", "latin1"))).toBe(false);
  expect(sent.includes(Buffer.from("ns.adobe.com", "latin1"))).toBe(false);
  // Only the parts that draw the picture, and the plain header: nothing an app block or a comment could hold.
  const markers = markersOf(sent);
  expect(markers.filter((m) => (m >= 0xe1 && m <= 0xef) || m === 0xfe)).toEqual(
    [],
  );
  expect(markers).toContain(0xda);
  expect(markers.at(-1)).toBe(0xd9);
  expect(store.uploads[0].headers["x-sha-256"]).toMatch(/^[0-9a-f]{64}$/);
  expect(store.uploads[0].headers.authorization).toMatch(/^Nostr /);

  // The post carries the description and the address, and the picture is drawn from this server with a signed read.
  await expect
    .poll(() => relay.events.some((e) => e.kind === 1 && e.pubkey === READER))
    .toBe(true);
  const post = relay.events.find((e) => e.kind === 1 && e.pubkey === READER);
  expect(post?.content).toMatch(
    new RegExp(`^Lit tonight #lamps\\n${ORIGIN}/media/[0-9a-f]{64}\\.jpg$`),
  );
  expect(post?.tags.find((t) => t[0] === "imeta")).toContain(
    "alt A red square",
  );
  const card = page.getByTestId("post-card").filter({ hasText: "Lit tonight" });
  const image = card.getByTestId("post-picture");
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("alt", "A red square");
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expect(card).not.toContainText("/media/");
  expect(store.reads.length).toBeGreaterThan(0);
  expect(store.reads.every((r) => r.authorization?.startsWith("Nostr "))).toBe(
    true,
  );
  await expectAccessible(page, "home with a picture");
  await expectNoSidewaysScroll(page, "home with a picture");
  // Nothing was asked of any other website.
  expect(requested).toEqual([]);
});

test("a failed upload says so, posts nothing and keeps the words, the picture and its description; the next try posts it", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  const store = await mediaStore(page, {
    failFirstUpload: "media service temporarily unavailable",
  });
  await install(page, relay, READER_KEY);
  await page.goto("/");
  const photo = await photoWithLocation(page);
  await page.getByTestId("home-compose").click();
  await page.getByTestId("composer-text").fill("Words that must survive");
  await page
    .getByTestId("composer-file")
    .setInputFiles({ name: "a.jpg", mimeType: "image/jpeg", buffer: photo });
  await page.getByLabel("Describe picture 1").fill("A red square");
  await page.getByTestId("composer-send").click();
  const problem = page.getByTestId("composer-problem");
  await expect(problem).toContainText("did not upload, so nothing was posted");
  await expect(problem).toContainText(
    "Uploads aren't working on this server just now",
  );
  expect(relay.events.some((e) => e.kind === 1 && e.pubkey === READER)).toBe(
    false,
  );
  await expect(page.getByTestId("composer-text")).toHaveValue(
    "Words that must survive",
  );
  await expect(page.getByLabel("Describe picture 1")).toHaveValue(
    "A red square",
  );
  await expectAccessible(page, "writing box after a failed upload");
  await page.getByTestId("composer-send").click();
  await expect
    .poll(() => relay.events.some((e) => e.kind === 1 && e.pubkey === READER))
    .toBe(true);
  expect(store.uploads).toHaveLength(1);
});

test("a picture on a post can be hidden from More and shown again, and a picture from another website is never loaded", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  const store = await mediaStore(page);
  const sha = "ab".repeat(32);
  await page.goto("about:blank");
  store.kept.set(sha, { sha, bytes: await photoWithLocation(page) });
  const url = `${ORIGIN}/media/${sha}.jpg`;
  relay.seed(
    event(
      1,
      FAY,
      `Look at this #lamps\n${url}`,
      [
        ["t", "lamps"],
        ["imeta", `url ${url}`, "alt Lamp on a table"],
      ],
      now() - 60,
    ),
  );
  relay.seed(
    event(
      1,
      FAY,
      "A tracker #lamps\nhttps://tracker.invalid/pixel.png",
      [
        ["t", "lamps"],
        ["imeta", "url https://tracker.invalid/pixel.png", "alt tracker"],
      ],
      now() - 70,
    ),
  );
  const outside: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("tracker.invalid")) outside.push(request.url());
  });
  await install(page, relay, READER_KEY);
  await page.goto("/");
  const card = page
    .getByTestId("post-card")
    .filter({ hasText: "Look at this" });
  await expect(card.getByTestId("post-picture")).toBeVisible();
  const path = new PressCounter();
  await path.press(
    card.getByRole("button", { name: "More actions for Fay Founder's post" }),
    "More",
  );
  await path.press(
    page.getByRole("button", { name: "Hide the picture" }),
    "Hide the picture",
  );
  expect(path.counts().presses).toBe(2);
  const covered = card.getByTestId("post-picture-hidden");
  await expect(covered).toBeVisible();
  await expect(card).toContainText("Look at this");
  await expectAccessible(page, "a hidden picture");
  // It stays hidden after a reload, and one press shows it again.
  await page.reload();
  await expect(card.getByTestId("post-picture-hidden")).toBeVisible();
  await card.getByTestId("post-picture-hidden").click();
  await expect(card.getByTestId("post-picture")).toBeVisible();
  // The other post's picture is on another website: it is not drawn and was never asked for.
  await expect(
    page.getByTestId("post-card").filter({ hasText: "A tracker" }),
  ).toBeVisible();
  expect(outside).toEqual([]);
});

test("a person's own post: Delete says what it can and cannot do, then removes it; Edit sends the changed post and takes the old one down", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedSocial(relay);
  relay.seed(
    event(
      1,
      READER,
      "My first lamp post #lamps",
      [["t", "lamps"]],
      now() - 120,
    ),
  );
  relay.seed(
    event(1, READER, "A post to delete #lamps", [["t", "lamps"]], now() - 100),
  );
  await install(page, relay, READER_KEY);
  await page.goto("/");
  const mine = page
    .getByTestId("post-card")
    .filter({ hasText: "A post to delete" });
  const remove = new PressCounter();
  await remove.press(
    mine.getByRole("button", { name: /More actions for Rae Reader's post/ }),
    "More",
  );
  await remove.press(page.getByRole("button", { name: "Delete" }), "Delete");
  const dialog = page.getByTestId("delete-dialog");
  await expect(dialog).toContainText("takes your post off this server");
  await expect(dialog).toContainText("It cannot take back copies");
  await expectAccessible(page, "the delete question");
  expect(relay.events.some((e) => e.kind === 5)).toBe(false);
  await remove.press(page.getByTestId("delete-confirm"), "Delete post");
  expect(remove.counts().presses).toBe(3);
  await expect(mine).toHaveCount(0);
  const deletion = relay.events.find((e) => e.kind === 5);
  expect(deletion?.tags.find((t) => t[0] === "k")).toEqual(["k", "1"]);
  await page.reload();
  await expect(page.getByTestId("home-posts")).not.toContainText(
    "A post to delete",
  );

  const first = page
    .getByTestId("post-card")
    .filter({ hasText: "My first lamp post" });
  await first
    .getByRole("button", { name: /More actions for Rae Reader's post/ })
    .click();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("composer-edit-note")).toContainText(
    "Likes on the old one do not carry over",
  );
  await expect(page.getByTestId("composer-text")).toHaveValue(
    "My first lamp post #lamps",
  );
  await page
    .getByTestId("composer-text")
    .fill("My first lamp post, fixed #lamps");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("home-posts")).toContainText(
    "My first lamp post, fixed",
  );
  await expect(page.getByTestId("home-posts")).not.toContainText(
    "My first lamp post #lamps",
  );
  expect(relay.events.filter((e) => e.kind === 5)).toHaveLength(2);
  await expectNoSidewaysScroll(page, "home after an edit");
});

test("a post can be reposted in two presses and quoted in three, and a follower's Home shows who reposted", async ({
  page,
}) => {
  const relay = createMockRelay();
  const { fay, max } = seedSocial(relay);
  // The reader follows Max; Max reposted Fay's post.
  relay.seed(
    event(
      3,
      READER,
      "",
      [
        ["p", FAY],
        ["p", max.pubkey],
      ],
      now() - 500,
    ),
  );
  relay.seed(
    event(
      6,
      max.pubkey,
      JSON.stringify(fay),
      [
        ["e", fay.id],
        ["p", FAY],
      ],
      now() - 30,
    ),
  );
  await install(page, relay, READER_KEY);
  await page.goto("/");
  const shared = page
    .getByTestId("post-card")
    .filter({ hasText: "First solar lamp is lit" });
  await expect(shared.getByTestId("post-reposted-by")).toHaveText(
    "Max Mate reposted",
  );

  const repost = new PressCounter();
  await repost.press(
    shared.getByRole("button", { name: "More actions for Fay Founder's post" }),
    "More",
  );
  await repost.press(page.getByRole("button", { name: "Repost" }), "Repost");
  expect(repost.counts().presses).toBe(2);
  await expect
    .poll(() => relay.events.find((e) => e.kind === 6 && e.pubkey === READER))
    .toBeTruthy();
  const mine = relay.events.find((e) => e.kind === 6 && e.pubkey === READER);
  expect(mine?.tags).toEqual([
    ["e", fay.id],
    ["p", FAY],
  ]);

  const quote = new PressCounter();
  await quote.press(
    shared.getByRole("button", { name: "More actions for Fay Founder's post" }),
    "More",
  );
  await quote.press(page.getByRole("button", { name: "Quote" }), "Quote");
  const sheet = page.getByTestId("composer");
  await expect(sheet.getByTestId("quoted-post")).toContainText(
    "First solar lamp is lit",
  );
  await quote.type(sheet.getByTestId("composer-text"), "Same here", "Words");
  await expectAccessible(page, "quoting a post");
  await quote.press(sheet.getByTestId("composer-send"), "Post");
  expect([quote.counts().presses, quote.counts().fields]).toEqual([3, 1]);
  await expect
    .poll(() => relay.events.find((e) => e.kind === 1 && e.pubkey === READER))
    .toBeTruthy();
  const quoted = relay.events.find((e) => e.kind === 1 && e.pubkey === READER);
  expect(quoted?.tags).toContainEqual(["q", fay.id, "", FAY]);
  // Opened on its own, the quote shows the post it quotes.
  await page.goto(`/post/${quoted?.id}`);
  await expect(
    page.getByTestId("post-focus").getByTestId("quoted-post"),
  ).toContainText("First solar lamp is lit");
  await expectNoSidewaysScroll(page, "a quote");
});
